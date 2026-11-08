package services

import (
	"errors"
	"math"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"sort"
	"time"

	"gorm.io/gorm"
)

type AchievementProgress struct {
	Current int    `json:"current"`
	Target  int    `json:"target"`
	Unit    string `json:"unit"`
	Series  string `json:"series"`
}

type AchievementSeriesItem struct {
	ID         uint   `json:"id"`
	Name       string `json:"name"`
	IsUnlocked bool   `json:"is_unlocked"`
	Target     int    `json:"target"`
}

type AchievementSource struct {
	RecordID  uint   `json:"record_id"`
	DishName  string `json:"dish_name"`
	MealDate  string `json:"meal_date"`
	MealType  string `json:"meal_type"`
	Available bool   `json:"available"`
}

type AchievementEstimate struct {
	Days          int `json:"days"`
	RecentRecords int `json:"recent_records"`
	WindowDays    int `json:"window_days"`
}

type AchievementDetails struct {
	IsUnlocked bool                    `json:"is_unlocked"`
	UnlockedAt *time.Time              `json:"unlocked_at"`
	Progress   *AchievementProgress    `json:"progress"`
	Series     []AchievementSeriesItem `json:"series"`
	Source     *AchievementSource      `json:"source"`
	Estimate   *AchievementEstimate    `json:"estimate"`
}

func estimateAchievement(p AchievementProgress, s achievementSnapshot) *AchievementEstimate {
	// 仅累计做菜数可以按近期节奏外推；连续天数、分类、库存等不作线性预测。
	if p.Series != "下厨记录" || p.Current >= p.Target || s.recentDays < 3 || s.recentRecords < 3 {
		return nil
	}
	return &AchievementEstimate{
		Days:          int(math.Ceil(float64(p.Target-p.Current) * 14 / float64(s.recentRecords))),
		RecentRecords: s.recentRecords, WindowDays: 14,
	}
}

// 详情按需计算，成就墙列表和全局解锁轮询不增加快照查询。
func GetAchievementDetails(achievement models.Achievement) (AchievementDetails, error) {
	result := AchievementDetails{Series: []AchievementSeriesItem{}}
	var awards []models.UserAchievement
	if err := database.DB.Order("unlocked_at ASC, id ASC").Find(&awards).Error; err != nil {
		return result, err
	}
	unlocked := map[uint]bool{}
	for _, award := range awards {
		unlocked[award.AchievementID] = true
		if award.AchievementID != achievement.ID || result.IsUnlocked {
			continue
		}
		result.IsUnlocked = true
		at := award.UnlockedAt
		result.UnlockedAt = &at
		if award.SourceRecordID > 0 {
			var record models.MealRecord
			err := database.DB.First(&record, award.SourceRecordID).Error
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return result, err
			}
			result.Source = &AchievementSource{
				RecordID: award.SourceRecordID, DishName: award.SourceDishName, MealDate: award.SourceMealDate, MealType: award.SourceMealType,
				Available: err == nil && record.Status == models.MealCompleted && record.MealDate == award.SourceMealDate && record.MealType == award.SourceMealType,
			}
		}
	}
	if achievement.Condition != "auto" {
		return result, nil
	}
	snapshot := buildAchievementSnapshot()
	if snapshot.err != nil {
		return result, snapshot.err
	}
	measures := measureAchievementProgress(snapshot)
	progress, ok := measures[achievement.Code]
	if !ok {
		return result, nil
	}
	result.Progress = &progress
	if !result.IsUnlocked {
		result.Estimate = estimateAchievement(progress, snapshot)
	}
	if progress.Series == "" {
		return result, nil
	}
	var all []models.Achievement
	if err := database.DB.Where("condition = ?", "auto").Find(&all).Error; err != nil {
		return result, err
	}
	for _, item := range all {
		p, ok := measures[item.Code]
		if ok && p.Series == progress.Series {
			result.Series = append(result.Series, AchievementSeriesItem{ID: item.ID, Name: item.Name, IsUnlocked: unlocked[item.ID], Target: p.Target})
		}
	}
	sort.Slice(result.Series, func(i, j int) bool {
		if result.Series[i].Target == result.Series[j].Target {
			return result.Series[i].ID < result.Series[j].ID
		}
		return result.Series[i].Target < result.Series[j].Target
	})
	return result, nil
}
