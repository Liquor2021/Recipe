package models

import "time"

type MealRecord struct {
	ID uint `json:"id" gorm:"primaryKey"`
	// idx_meal_records_unique_day 在这里只声明为普通索引：唯一约束由
	// database.migrateMealRecordUniqueIndex 在合并历史重复记录之后再升级。
	// 若在 tag 里写 uniqueIndex，AutoMigrate 会抢先建唯一索引，旧库有重复数据时直接启动失败。
	DishID    uint      `json:"dish_id" gorm:"not null;index;index:idx_meal_records_unique_day,priority:1"`
	DishName  string    `json:"dish_name" gorm:"not null"`
	MealType  string    `json:"meal_type" gorm:"not null;index;index:idx_meal_records_unique_day,priority:2;index:idx_meal_records_date_type,priority:2"`
	MealDate  string    `json:"meal_date" gorm:"not null;index;index:idx_meal_records_unique_day,priority:3;index:idx_meal_records_date_type,priority:1"`
	Rating    int       `json:"rating" gorm:"default:0"`
	Remark    string    `json:"remark"`
	Mood      string    `json:"mood" gorm:"index"`
	Photo     string    `json:"photo"`
	CreatedAt time.Time `json:"created_at" gorm:"index"`
}
