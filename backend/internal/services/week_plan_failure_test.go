package services

import (
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"reflect"
	"testing"

	"gorm.io/gorm"
)

func TestWeekPlanReadFailuresPreserveSavedPlan(t *testing.T) {
	for _, stage := range []struct {
		name      string
		cold      bool
		operation string
		settings  string
		dishRead  int
	}{
		{name: "settings", settings: "config"},
		{name: "persisted cache", cold: true, settings: "cache"},
		{name: "cached dishes", dishRead: 1},
		{name: "regenerate candidates", operation: "regenerate", dishRead: 1},
		{name: "save lookup", operation: "regenerate", settings: "cache"},
		{name: "swap candidates", operation: "swap", dishRead: 2},
	} {
		t.Run(stage.name, func(t *testing.T) {
			setupWeekPlanTestDB(t)
			seedPlanDishes(t)
			seedWeekPlanRecord(t, 1, 2)
			original := requireWeekPlan(t, GetCachedWeekPlan)
			if stage.cold {
				cachedRecord = nil
			}
			before := cachedRecord
			injected := errors.New("injected week plan read failure")
			failing, hit, dishReads := true, false, 0
			writes := 0
			if err := database.DB.Callback().Query().Before("gorm:query").Register("test:week_plan_read_failure", func(tx *gorm.DB) {
				if !failing {
					return
				}
				match := false
				switch tx.Statement.Dest.(type) {
				case *[]models.Setting:
					match = stage.settings == "config"
				case *models.Setting:
					match = stage.settings == "cache"
				case *[]models.Dish:
					dishReads++
					match = dishReads == stage.dishRead
				}
				if match {
					hit = true
					tx.AddError(injected)
				}
			}); err != nil {
				t.Fatal(err)
			}
			countWrite := func(tx *gorm.DB) {
				if tx.Statement.Table == "settings" {
					writes++
				}
			}
			if err := database.DB.Callback().Create().Before("gorm:create").Register("test:week_plan_count_write", countWrite); err != nil {
				t.Fatal(err)
			}
			if err := database.DB.Callback().Update().Before("gorm:update").Register("test:week_plan_count_write", countWrite); err != nil {
				t.Fatal(err)
			}
			var plan *WeekPlan
			var err error
			switch stage.operation {
			case "regenerate":
				plan, err = RegenerateWeekPlan()
			case "swap":
				var picked models.Dish
				plan, picked, err = SwapWeekPlanDish(weekDates()[0], "lunch", 1)
				if picked.ID != 0 {
					t.Fatalf("failed swap returned an unconfirmed dish: %+v", picked)
				}
			default:
				plan, err = GetCachedWeekPlan()
			}
			if !hit || !errors.Is(err, injected) || plan != nil || cachedRecord != before || writes != 0 {
				t.Fatalf("read failure must not regenerate or replace cache: hit=%v plan=%v err=%v changed=%v writes=%d", hit, plan, err, cachedRecord != before, writes)
			}
			failing = false
			cachedRecord = nil
			reloaded := requireWeekPlan(t, GetCachedWeekPlan)
			if !reflect.DeepEqual(planDishIDs(original), planDishIDs(reloaded)) {
				t.Fatalf("read failure changed the persisted plan after restart")
			}
		})
	}
}

func TestWeekPlanWriteFailuresDoNotReplaceMemory(t *testing.T) {
	for _, operation := range []string{"initial", "regenerate", "swap"} {
		t.Run(operation, func(t *testing.T) {
			setupWeekPlanTestDB(t)
			seedPlanDishes(t)
			var original *WeekPlan
			if operation != "initial" {
				seedWeekPlanRecord(t, 1, 2)
				original = requireWeekPlan(t, GetCachedWeekPlan)
			}
			before := cachedRecord
			injected := errors.New("injected week plan save failure")
			failing, hit := true, false
			failWrite := func(tx *gorm.DB) {
				if failing && tx.Statement.Table == "settings" {
					hit = true
					tx.AddError(injected)
				}
			}
			if err := database.DB.Callback().Create().Before("gorm:create").Register("test:week_plan_save_failure", failWrite); err != nil {
				t.Fatal(err)
			}
			if err := database.DB.Callback().Update().Before("gorm:update").Register("test:week_plan_save_failure", failWrite); err != nil {
				t.Fatal(err)
			}
			var plan *WeekPlan
			var err error
			switch operation {
			case "initial":
				plan, err = GetCachedWeekPlan()
			case "regenerate":
				plan, err = RegenerateWeekPlan()
			case "swap":
				var picked models.Dish
				plan, picked, err = SwapWeekPlanDish(weekDates()[0], "lunch", 1)
				if picked.ID != 0 {
					t.Fatalf("failed save returned an unconfirmed dish: %+v", picked)
				}
			}
			if !hit || !errors.Is(err, injected) || plan != nil || cachedRecord != before {
				t.Fatalf("save failure must retain confirmed memory: hit=%v plan=%v err=%v changed=%v", hit, plan, err, cachedRecord != before)
			}
			failing = false
			cachedRecord = nil
			if original != nil {
				reloaded := requireWeekPlan(t, GetCachedWeekPlan)
				if !reflect.DeepEqual(planDishIDs(original), planDishIDs(reloaded)) {
					t.Fatalf("failed save changed persisted plan after restart")
				}
			} else {
				var count int64
				if err := database.DB.Model(&models.Setting{}).Where("`key` = ?", "week_plan_cache").Count(&count).Error; err != nil || count != 0 {
					t.Fatalf("failed initial save created a cache: count=%d err=%v", count, err)
				}
			}
			// 保存恢复后可重试，成功响应必须与重启后读回的菜单一致。
			saved := requireWeekPlan(t, RegenerateWeekPlan)
			cachedRecord = nil
			reloaded := requireWeekPlan(t, GetCachedWeekPlan)
			if !reflect.DeepEqual(planDishIDs(saved), planDishIDs(reloaded)) {
				t.Fatalf("successful response disagrees with persisted plan")
			}
		})
	}
}
