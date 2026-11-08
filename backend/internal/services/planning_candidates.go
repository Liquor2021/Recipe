package services

import (
	"math/rand"
	"ninimenu/internal/models"
	"time"
)

type PlanningCandidates struct {
	Lunch, Dinner           []models.Dish
	LunchCount, DinnerCount int
}

// 使用周推荐相同的家庭忌口、餐别和数量设置；候选一次读取，事务内不另取连接。
func LoadPlanningCandidates() (PlanningCandidates, error) {
	cfg, err := loadWeekPlanConfig()
	if err != nil {
		return PlanningCandidates{}, err
	}
	lunch, dinner, _, err := weekPlanPools(cfg)
	if err != nil {
		return PlanningCandidates{}, err
	}
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	weight := weekPlanWeight(cfg, lunch, dinner)
	return PlanningCandidates{
		Lunch:      pickNDishes(lunch, len(lunch), map[uint]bool{}, map[uint]bool{}, r, weight),
		Dinner:     pickNDishes(dinner, len(dinner), map[uint]bool{}, map[uint]bool{}, r, weight),
		LunchCount: min(5, cfg.lunchCount), DinnerCount: min(5, cfg.dinnerCount),
	}, nil
}
