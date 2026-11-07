package handlers

import (
	"ninimenu/internal/database"
	"ninimenu/internal/models"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// 更新只包含请求明确提交的列；删除照片不会清空备注，首页心情也不会覆盖评价。
// 使用单条 upsert，避免两个入口同时首次保存时重复创建同一天，或读旧快照后互相覆盖。
func saveDayRatingFields(rating *models.DayRating, fields []string) error {
	columns := append(append([]string(nil), fields...), "updated_at")
	return database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "meal_date"}},
			DoUpdates: clause.AssignmentColumns(columns),
		}).Create(rating).Error; err != nil {
			return err
		}
		return tx.Where("meal_date = ?", rating.MealDate).First(rating).Error
	})
}
