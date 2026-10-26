package models

import "time"

type MealRecord struct {
	ID        uint      `json:"id" gorm:"primaryKey"`
	DishID    uint      `json:"dish_id" gorm:"not null;index;uniqueIndex:idx_meal_records_unique_day,priority:1"`
	DishName  string    `json:"dish_name" gorm:"not null"`
	MealType  string    `json:"meal_type" gorm:"not null;index;uniqueIndex:idx_meal_records_unique_day,priority:2;index:idx_meal_records_date_type,priority:2"`
	MealDate  string    `json:"meal_date" gorm:"not null;index;uniqueIndex:idx_meal_records_unique_day,priority:3;index:idx_meal_records_date_type,priority:1"`
	Rating    int       `json:"rating" gorm:"default:0"`
	Remark    string    `json:"remark"`
	Mood      string    `json:"mood" gorm:"index"`
	Photo     string    `json:"photo"`
	CreatedAt time.Time `json:"created_at" gorm:"index"`
}
