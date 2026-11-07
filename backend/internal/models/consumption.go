package models

import "time"

const (
	ConsumptionApplied  = "applied"
	ConsumptionReverted = "reverted"
)

// RecordConsumption 保存一次用餐扣库存的完整快照。撤销后保留日志，
// ActiveRecordID 置空，允许该用餐重新扣减，同时确保最多只有一次生效中的扣减。
type RecordConsumption struct {
	ID             uint       `json:"id" gorm:"primaryKey"`
	RecordID       uint       `json:"record_id" gorm:"not null;index"`
	ActiveRecordID *uint      `json:"-" gorm:"uniqueIndex"`
	Status         string     `json:"status" gorm:"not null"`
	Snapshots      string     `json:"-" gorm:"type:text;not null"`
	CreatedAt      time.Time  `json:"created_at"`
	RevertedAt     *time.Time `json:"reverted_at,omitempty"`
}
