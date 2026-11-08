package models

import (
	"time"

	"gorm.io/gorm"
)

// 金额统一保存为分，避免小数累计误差。删除后保留请求号，重试不会复活旧账。
type Expense struct {
	ID           uint           `json:"id" gorm:"primaryKey"`
	AmountCents  int64          `json:"amount_cents" gorm:"not null"`
	Category     string         `json:"category" gorm:"not null"`
	Source       string         `json:"source" gorm:"not null"`
	ExpenseDate  string         `json:"expense_date" gorm:"not null;index"`
	Note         string         `json:"note"`
	ShoppingItem string         `json:"shopping_item"`
	RequestID    string         `json:"-" gorm:"not null;uniqueIndex"`
	RequestHash  string         `json:"-" gorm:"not null"`
	Revision     int            `json:"revision" gorm:"not null;default:1"`
	CreatedAt    time.Time      `json:"created_at"`
	UpdatedAt    time.Time      `json:"updated_at"`
	DeletedAt    gorm.DeletedAt `json:"-" gorm:"index"`
}
