package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var errDayRatingChanged = errors.New("评价或照片已变化，请核对最新内容后再保存；你的草稿已保留")

type DayRatingSnapshot struct {
	models.DayRating
	Version string `json:"version"`
}

// 首页心情是独立入口，不能让它的更新阻止评价/照片编辑。
// 版本只覆盖编辑器拥有的内容；空记录与仅保存了首页心情的记录使用同一基线。
func dayRatingSnapshot(rating models.DayRating) DayRatingSnapshot {
	photos := rating.Photos
	if photos == "" {
		photos = "[]"
	}
	encoded, _ := json.Marshal([]string{"day-rating-v1", rating.MealDate, rating.Mood, rating.Remark, photos})
	digest := sha256.Sum256(encoded)
	rating.Photos = photos
	return DayRatingSnapshot{DayRating: rating, Version: hex.EncodeToString(digest[:])}
}

func readDayRatingSnapshot(tx *gorm.DB, date string) (DayRatingSnapshot, error) {
	rating := models.DayRating{MealDate: date, Photos: "[]"}
	if err := tx.Where("meal_date = ?", date).First(&rating).Error; err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return DayRatingSnapshot{}, err
	}
	return dayRatingSnapshot(rating), nil
}

func upsertDayRatingFields(tx *gorm.DB, rating *models.DayRating, fields []string) error {
	columns := append(append([]string(nil), fields...), "updated_at")
	if err := tx.Clauses(clause.OnConflict{
		Columns: []clause.Column{{Name: "meal_date"}}, DoUpdates: clause.AssignmentColumns(columns),
	}).Create(rating).Error; err != nil {
		return err
	}
	return tx.Where("meal_date = ?", rating.MealDate).First(rating).Error
}

// 更新只包含请求明确提交的列；删除照片不会清空备注，首页心情也不会覆盖评价。
// 使用单条 upsert，避免两个入口同时首次保存时重复创建同一天，或读旧快照后互相覆盖。
func saveDayRatingFields(rating *models.DayRating, fields []string) error {
	return database.DB.Transaction(func(tx *gorm.DB) error {
		return upsertDayRatingFields(tx, rating, fields)
	})
}

func saveExpectedDayRatingFields(rating *models.DayRating, fields []string, expected string) error {
	if len(expected) != 64 {
		return errDayRatingChanged
	}
	return database.DB.Transaction(func(tx *gorm.DB) error {
		// 在读取基线之前获得 SQLite 写锁，包括第一次创建当天评价的情况。
		if err := tx.Model(&models.DayRating{}).Where("meal_date = ?", rating.MealDate).UpdateColumn("id", gorm.Expr("id")).Error; err != nil {
			return err
		}
		current, err := readDayRatingSnapshot(tx, rating.MealDate)
		if err != nil {
			return err
		}
		if current.Version != expected {
			return errDayRatingChanged
		}
		return upsertDayRatingFields(tx, rating, fields)
	})
}
