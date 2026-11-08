package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type MealPlanDay struct {
	Date string `json:"date"`
	MealPlanSnapshot
}
type MealPlanWeek struct {
	Days     []MealPlanDay `json:"days"`
	Version  string        `json:"version"`
	Replayed bool          `json:"replayed,omitempty"`
}
type RegenerateMealPlanWeekRequest struct {
	ExpectedVersion string `json:"expected_version"`
	RequestID       string `json:"request_id"`
}

var errPlanCandidates = errors.New("可用菜品不足以排出不重复的菜单，请增加菜品、调整忌口或手动安排；原菜单已保留")

func weekStart(date string) time.Time {
	d, _ := time.ParseInLocation("2006-01-02", date, time.Local)
	return d.AddDate(0, 0, -(int(d.Weekday())+6)%7)
}

func readMealPlanWeek(tx *gorm.DB, start time.Time) (MealPlanWeek, error) {
	week := MealPlanWeek{Days: []MealPlanDay{}}
	versions := ""
	for i := 0; i < 7; i++ {
		date := start.AddDate(0, 0, i).Format("2006-01-02")
		snapshot, _, err := readMealPlanSnapshot(tx, date)
		if err != nil {
			return week, err
		}
		week.Days = append(week.Days, MealPlanDay{Date: date, MealPlanSnapshot: snapshot})
		versions += date + snapshot.Version
	}
	digest := sha256.Sum256([]byte(versions))
	week.Version = hex.EncodeToString(digest[:])
	return week, nil
}

func GetMealPlanWeek(c *gin.Context) {
	date, ok := mealPlanDate(c)
	if !ok {
		return
	}
	var week MealPlanWeek
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		week, err = readMealPlanWeek(tx, weekStart(date))
		return err
	})
	if err != nil {
		utils.InternalError(c, "读取一周菜单失败")
		return
	}
	utils.Success(c, week)
}

// 整周基线、钉住状态、记录与采购在同一事务内校验和写入，不会出现半周成功。
func regenerateMealPlanWeek(start time.Time, req RegenerateMealPlanWeekRequest, pool services.PlanningCandidates) (MealPlanWeek, error) {
	var result MealPlanWeek
	encoded, _ := json.Marshal(req)
	digest := sha256.Sum256(encoded)
	requestHash := hex.EncodeToString(digest[:])
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&models.MealRecord{}).Where("meal_date >= ? AND meal_date <= ?", start.Format("2006-01-02"), start.AddDate(0, 0, 6).Format("2006-01-02")).UpdateColumn("id", gorm.Expr("id")).Error; err != nil {
			return err
		}
		current, err := readMealPlanWeek(tx, start)
		if err != nil {
			return err
		}
		key := "meal_plan_week_save:" + start.Format("2006-01-02")
		var setting models.Setting
		if err := tx.Where("`key` = ?", key).First(&setting).Error; err == nil {
			var receipt mealPlanReceipt
			if json.Unmarshal([]byte(setting.Value), &receipt) == nil && receipt.RequestID == req.RequestID {
				if receipt.RequestHash != requestHash || receipt.ResultVersion != current.Version {
					return errMealPlanChanged
				}
				result = current
				result.Replayed = true
				return nil
			}
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if req.ExpectedVersion != current.Version {
			return errMealPlanChanged
		}
		today := time.Now().Format("2006-01-02")
		used := map[uint]bool{}
		for _, day := range current.Days {
			for _, row := range day.Records {
				if day.Date < today || row.Status != models.MealPlanned || row.PlanPinned {
					used[row.DishID] = true
				}
			}
		}
		for i, day := range current.Days {
			if day.Date < today {
				continue
			}
			dishes := []MealPlanDish{}
			for _, meal := range []string{"lunch", "dinner"} {
				count, kept := 0, 0
				oldIDs := map[uint]bool{}
				for _, row := range day.Records {
					if row.MealType != meal {
						continue
					}
					count++
					oldIDs[row.DishID] = true
					if row.Status != models.MealPlanned || row.PlanPinned {
						pin := row.PlanPinned
						dishes = append(dishes, MealPlanDish{DishID: row.DishID, MealType: meal, Pinned: &pin})
						kept++
					}
				}
				candidates, target := pool.Lunch, pool.LunchCount
				if meal == "dinner" {
					candidates, target = pool.Dinner, pool.DinnerCount
				}
				if count > 0 {
					target = count
				}
				if target > 5 {
					return errPlanCandidates
				}
				// 优先换成新菜；候选较少时允许保留原菜，但整周新增安排绝不重复。
				for pass := 0; pass < 2 && kept < target; pass++ {
					for _, dish := range candidates {
						if used[dish.ID] || (pass == 0 && oldIDs[dish.ID]) {
							continue
						}
						dishes = append(dishes, MealPlanDish{DishID: dish.ID, MealType: meal})
						used[dish.ID] = true
						kept++
						if kept == target {
							break
						}
					}
				}
				if kept < target {
					return errPlanCandidates
				}
			}
			_, err := saveMealPlanTx(tx, day.Date, SaveMealPlanRequest{ExpectedVersion: day.Version, RequestID: fmt.Sprintf("%s_%d", req.RequestID, i), Dishes: dishes})
			if err != nil {
				return err
			}
		}
		result, err = readMealPlanWeek(tx, start)
		if err != nil {
			return err
		}
		receipt, _ := json.Marshal(mealPlanReceipt{RequestID: req.RequestID, RequestHash: requestHash, ResultVersion: result.Version})
		return tx.Where("`key` = ?", key).Assign(models.Setting{Key: key, Value: string(receipt)}).FirstOrCreate(&models.Setting{}).Error
	})
	return result, err
}

func RegenerateMealPlanWeek(c *gin.Context) {
	date, ok := mealPlanDate(c)
	if !ok {
		return
	}
	start := weekStart(date)
	if start.AddDate(0, 0, 6).Format("2006-01-02") < time.Now().Format("2006-01-02") {
		utils.BadRequest(c, "过去的菜单不再重排")
		return
	}
	var req RegenerateMealPlanWeekRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.ExpectedVersion) != 64 || !mealPlanRequestID.MatchString(req.RequestID) {
		utils.BadRequest(c, "请重新读取菜单后再重排")
		return
	}
	pool, err := services.LoadPlanningCandidates()
	if err != nil {
		utils.InternalError(c, "读取候选菜失败，菜单未改动")
		return
	}
	week, err := regenerateMealPlanWeek(start, req, pool)
	switch {
	case errors.Is(err, errMealPlanChanged):
		utils.Conflict(c, err.Error())
	case errors.Is(err, errPlanCandidates):
		utils.BadRequest(c, err.Error())
	case err != nil:
		utils.InternalError(c, "重排失败，全部改动均未生效，请重试")
	default:
		if !week.Replayed {
			services.RecordUniqueAchievementEvent("week_plan", start.Format("2006-01-02"))
			services.QueueAutoAchievementSync()
		}
		utils.Success(c, week)
	}
}
