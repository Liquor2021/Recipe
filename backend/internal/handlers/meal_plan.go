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
	"regexp"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type MealPlanSnapshot struct {
	Records  []models.MealRecord `json:"records"`
	Version  string              `json:"version"`
	Replayed bool                `json:"replayed,omitempty"`
}

type MealPlanDish struct {
	DishID   uint   `json:"dish_id"`
	MealType string `json:"meal_type"`
	Pinned   *bool  `json:"pinned,omitempty"`
}

type SaveMealPlanRequest struct {
	ExpectedVersion string         `json:"expected_version"`
	RequestID       string         `json:"request_id"`
	Dishes          []MealPlanDish `json:"dishes"`
}

type mealPlanReceipt struct {
	RequestID     string `json:"request_id"`
	RequestHash   string `json:"request_hash"`
	ResultVersion string `json:"result_version"`
}

var errMealPlanChanged = errors.New("菜单已变化，请核对最新菜单后再保存")
var mealPlanRequestID = regexp.MustCompile(`^[a-zA-Z0-9_-]{16,80}$`)

func mealPlanDate(c *gin.Context) (string, bool) {
	date := c.Param("date")
	parsed, err := time.Parse("2006-01-02", date)
	if err != nil || parsed.Format("2006-01-02") != date {
		utils.BadRequest(c, "日期格式应为 YYYY-MM-DD")
		return "", false
	}
	return date, true
}

func readMealPlanSnapshot(tx *gorm.DB, date string) (MealPlanSnapshot, []models.MealRecord, error) {
	rows := []models.MealRecord{}
	if err := tx.Where("meal_date = ?", date).Order("id ASC").Find(&rows).Error; err != nil {
		return MealPlanSnapshot{}, nil, err
	}
	encoded, err := json.Marshal(rows)
	if err != nil {
		return MealPlanSnapshot{}, nil, err
	}
	digest := sha256.Sum256(encoded)
	snapshot := MealPlanSnapshot{Records: []models.MealRecord{}, Version: hex.EncodeToString(digest[:])}
	for _, row := range rows {
		if row.Status != models.MealCancelled {
			snapshot.Records = append(snapshot.Records, row)
		}
	}
	return snapshot, rows, nil
}

func GetMealPlan(c *gin.Context) {
	date, ok := mealPlanDate(c)
	if !ok {
		return
	}
	snapshot, _, err := readMealPlanSnapshot(database.DB, date)
	if err != nil {
		utils.InternalError(c, "读取菜单失败")
		return
	}
	utils.Success(c, snapshot)
}

// saveMealPlan 核对基线、改菜单和购物联动共用事务，避免客户端预读后的竞态窗口。
func saveMealPlan(date string, req SaveMealPlanRequest) (MealPlanSnapshot, error) {
	var result MealPlanSnapshot
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		result, err = saveMealPlanTx(tx, date, req)
		return err
	})
	return result, err
}

func saveMealPlanTx(tx *gorm.DB, date string, req SaveMealPlanRequest) (MealPlanSnapshot, error) {
	var result MealPlanSnapshot
	requestBytes, _ := json.Marshal(req)
	requestDigest := sha256.Sum256(requestBytes)
	requestHash := hex.EncodeToString(requestDigest[:])
	err := func() error {
		// 首条语句是写操作（即使该日期尚无记录），先取得 SQLite 写锁再读基线。
		if err := tx.Model(&models.MealRecord{}).Where("meal_date = ?", date).UpdateColumn("id", gorm.Expr("id")).Error; err != nil {
			return err
		}
		current, rows, err := readMealPlanSnapshot(tx, date)
		if err != nil {
			return err
		}
		key := "meal_plan_save:" + date
		var setting models.Setting
		if err := tx.Where("`key` = ?", key).First(&setting).Error; err == nil {
			var receipt mealPlanReceipt
			if json.Unmarshal([]byte(setting.Value), &receipt) == nil && receipt.RequestID == req.RequestID {
				if receipt.RequestHash != requestHash || receipt.ResultVersion != current.Version {
					return errMealPlanChanged
				}
				current.Replayed = true
				result = current
				return nil
			}
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if current.Version != req.ExpectedVersion {
			return errMealPlanChanged
		}
		byKey := make(map[string]models.MealRecord, len(rows))
		for _, row := range rows {
			byKey[fmt.Sprintf("%s:%d", row.MealType, row.DishID)] = row
		}
		desired := make(map[string]bool, len(req.Dishes))
		for _, selected := range req.Dishes {
			entryKey := fmt.Sprintf("%s:%d", selected.MealType, selected.DishID)
			desired[entryKey] = true
			existing, exists := byKey[entryKey]
			if exists && existing.Status != models.MealCancelled {
				if existing.Status == models.MealPlanned && selected.Pinned != nil && existing.PlanPinned != *selected.Pinned {
					if err := tx.Model(&existing).Update("plan_pinned", *selected.Pinned).Error; err != nil {
						return err
					}
				}
				continue
			}
			// 保留原菜单不受菜谱下架影响；新增或恢复则必须仍能点这道菜。
			var dish models.Dish
			if err := tx.Where("id = ? AND enabled = ?", selected.DishID, true).First(&dish).Error; err != nil {
				if errors.Is(err, gorm.ErrRecordNotFound) {
					return errMealPlanChanged
				}
				return err
			}
			if exists {
				before := existing
				existing.Status = models.MealPlanned
				existing.PlanPinned = selected.Pinned != nil && *selected.Pinned
				if err := tx.Save(&existing).Error; err != nil {
					return err
				}
				if err := syncRecordShopping(tx, before, existing); err != nil {
					return err
				}
				continue
			}
			record := models.MealRecord{DishID: dish.ID, DishName: dish.Name, MealType: selected.MealType, MealDate: date, Status: models.MealPlanned, PortionScale: 1, PlanPinned: selected.Pinned != nil && *selected.Pinned}
			if err := tx.Create(&record).Error; err != nil {
				return err
			}
			if err := addShoppingItems(tx, dish.ID, dish.Name, selected.MealType, date, 1); err != nil {
				return err
			}
		}
		for entryKey, record := range byKey {
			if desired[entryKey] || record.Status == models.MealCancelled {
				continue
			}
			// 今天可以继续加菜，但已吃记录及其评价、库存处理绝不能被排菜覆盖。
			if record.Status != models.MealPlanned {
				return errMealPlanChanged
			}
			before := record
			record.Status = models.MealCancelled
			if err := tx.Save(&record).Error; err != nil {
				return err
			}
			if err := syncRecordShopping(tx, before, record); err != nil {
				return err
			}
		}
		result, _, err = readMealPlanSnapshot(tx, date)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(mealPlanReceipt{RequestID: req.RequestID, RequestHash: requestHash, ResultVersion: result.Version})
		if err != nil {
			return err
		}
		// 每个日期仅保留最近一次成功保存的回执，供响应丢失后的安全重试。
		return tx.Where("`key` = ?", key).Assign(models.Setting{Key: key, Value: string(encoded)}).FirstOrCreate(&models.Setting{}).Error
	}()
	return result, err
}

func SaveMealPlan(c *gin.Context) {
	date, ok := mealPlanDate(c)
	if !ok {
		return
	}
	if date < time.Now().Format("2006-01-02") {
		utils.Conflict(c, "只能安排今天或未来的菜单，请重新选择日期")
		return
	}
	var req SaveMealPlanRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.ExpectedVersion) != 64 || !mealPlanRequestID.MatchString(req.RequestID) || req.Dishes == nil || len(req.Dishes) > 10 {
		utils.BadRequest(c, "菜单参数无效，请重新读取后再保存")
		return
	}
	counts, seen := map[string]int{}, map[string]bool{}
	for _, selected := range req.Dishes {
		key := fmt.Sprintf("%s:%d", selected.MealType, selected.DishID)
		if selected.DishID == 0 || (selected.MealType != "lunch" && selected.MealType != "dinner") || seen[key] {
			utils.BadRequest(c, "菜品或餐次无效，不能重复添加")
			return
		}
		seen[key] = true
		counts[selected.MealType]++
		if counts[selected.MealType] > 5 {
			utils.BadRequest(c, "每餐最多 5 道菜")
			return
		}
	}
	result, err := saveMealPlan(date, req)
	if errors.Is(err, errMealPlanChanged) {
		utils.Conflict(c, err.Error())
		return
	}
	if err != nil {
		utils.InternalError(c, "菜单保存失败，所有改动均未生效，请重试")
		return
	}
	services.QueueAutoAchievementSync()
	utils.Success(c, result)
}
