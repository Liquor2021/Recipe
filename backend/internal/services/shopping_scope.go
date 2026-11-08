package services

import (
	"errors"
	"gorm.io/gorm"
	"ninimenu/internal/models"
	"time"
)

func ShoppingPlanDays(tx *gorm.DB) (int, error) {
	var setting models.Setting
	err := tx.Where("`key` = ?", "shopping_plan_days").First(&setting).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 2, nil
	}
	if err != nil {
		return 0, err
	}
	if setting.Value == "7" {
		return 7, nil
	}
	if setting.Value == "2" {
		return 2, nil
	}
	return 0, errors.New("采购范围设置无效")
}

func ShoppingPlanDates(tx *gorm.DB) ([]string, error) {
	days, err := ShoppingPlanDays(tx)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	dates := make([]string, days)
	for i := range dates {
		dates[i] = now.AddDate(0, 0, i).Format("2006-01-02")
	}
	return dates, nil
}
