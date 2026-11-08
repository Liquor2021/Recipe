package handlers

import (
	"errors"
	"fmt"
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"
	"time"
)

func TestMealPlanTodayKeepsCompletedDetailsAndPin(t *testing.T) {
	db, _, dishes := setupMealPlanTest(t)
	date := time.Now().Format("2006-01-02")
	done := testCreateMeal(t, CreateRecordRequest{DishID: dishes[0].ID, DishName: dishes[0].Name, MealDate: date, MealType: "lunch"})
	if err := db.Model(&done).Updates(map[string]any{"status": models.MealCompleted, "rating": 5, "inventory_applied": true, "portion_scale": 2}).Error; err != nil {
		t.Fatal(err)
	}
	pin := true
	req := planTestRequest(t, db, date, "today_plan_keep_completed", MealPlanDish{DishID: done.DishID, MealType: "lunch"}, MealPlanDish{DishID: dishes[1].ID, MealType: "dinner", Pinned: &pin})
	w := serveJSON(t, SaveMealPlan, "PUT", "/meal-plans/"+date, req, gin.Param{Key: "date", Value: date})
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	snapshot := planTestSnapshot(t, db, date)
	if len(snapshot.Records) != 2 || snapshot.Records[0].Rating != 5 || !snapshot.Records[0].InventoryApplied || snapshot.Records[0].PortionScale != 2 || !snapshot.Records[1].PlanPinned {
		t.Fatalf("lost completed details or pin: %+v", snapshot)
	}
	bad := planTestRequest(t, db, date, "today_plan_remove_completed", MealPlanDish{DishID: dishes[2].ID, MealType: "lunch"})
	if _, err := saveMealPlan(date, bad); !errors.Is(err, errMealPlanChanged) {
		t.Fatalf("completed removal allowed: %v", err)
	}
	if after := planTestSnapshot(t, db, date); after.Version != snapshot.Version {
		t.Fatal("partial changes survived rejected save")
	}
	// Existing callers that omit pin metadata must preserve the user's pin.
	keep := planTestRequest(t, db, date, "today_plan_legacy_pin", MealPlanDish{DishID: done.DishID, MealType: "lunch"}, MealPlanDish{DishID: dishes[1].ID, MealType: "dinner"})
	if result, err := saveMealPlan(date, keep); err != nil || !result.Records[1].PlanPinned {
		t.Fatal("pin lost on legacy caller", err)
	}
}

func setupRealWeekTest(t *testing.T) (*gorm.DB, time.Time, services.PlanningCandidates) {
	db, _, dishes := setupMealPlanTest(t)
	for i := len(dishes); i < 32; i++ {
		d := models.Dish{Name: fmt.Sprintf("周菜%d", i), Enabled: true, MealType: "all", Ingredients: `[{"name":"番茄","amount":"1个"}]`}
		if err := db.Create(&d).Error; err != nil {
			t.Fatal(err)
		}
		dishes = append(dishes, d)
	}
	start := weekStart(time.Now().AddDate(0, 0, 14).Format("2006-01-02"))
	return db, start, services.PlanningCandidates{Lunch: dishes, Dinner: dishes, LunchCount: 1, DinnerCount: 1}
}

func TestRealWeekRegenerateKeepsPinsDeduplicatesAndReplays(t *testing.T) {
	db, start, pool := setupRealWeekTest(t)
	date := start.Format("2006-01-02")
	pin := true
	_, err := saveMealPlan(date, planTestRequest(t, db, date, "week_pin_seed_request", MealPlanDish{DishID: pool.Lunch[0].ID, MealType: "lunch", Pinned: &pin}, MealPlanDish{DishID: pool.Lunch[1].ID, MealType: "lunch"}))
	if err != nil {
		t.Fatal(err)
	}
	before, err := readMealPlanWeek(db, start)
	if err != nil {
		t.Fatal(err)
	}
	req := RegenerateMealPlanWeekRequest{ExpectedVersion: before.Version, RequestID: "real_week_generate_request"}
	result, err := regenerateMealPlanWeek(start, req, pool)
	if err != nil {
		t.Fatal(err)
	}
	seen := map[uint]bool{}
	for _, day := range result.Days {
		for _, row := range day.Records {
			if seen[row.DishID] {
				t.Fatal("generated duplicate", row.DishID)
			}
			seen[row.DishID] = true
		}
	}
	if len(result.Days) != 7 || len(seen) != 15 {
		t.Fatalf("wrong week or targets: %+v", result)
	}
	kept := result.Days[0].Records[0]
	if kept.ID != before.Days[0].Records[0].ID || !kept.PlanPinned {
		t.Fatal("pin was not preserved")
	}
	replayed, err := regenerateMealPlanWeek(start, req, pool)
	if err != nil || !replayed.Replayed || replayed.Version != result.Version {
		t.Fatal("replay failed", err)
	}
	req.RequestID = "real_week_stale_request"
	if _, err := regenerateMealPlanWeek(start, req, pool); !errors.Is(err, errMealPlanChanged) {
		t.Fatal("stale week accepted", err)
	}
	var shopping int64
	if err := db.Model(&models.ShoppingCheck{}).Count(&shopping).Error; err != nil || shopping != 15 {
		t.Fatal("shopping not in sync", shopping, err)
	}
}

func TestRealWeekRollsBackEarlierDaysOnInsufficientCandidates(t *testing.T) {
	db, start, pool := setupRealWeekTest(t)
	before, err := readMealPlanWeek(db, start)
	if err != nil {
		t.Fatal(err)
	}
	pool.Lunch = pool.Lunch[:4]
	pool.Dinner = pool.Dinner[:4]
	_, err = regenerateMealPlanWeek(start, RegenerateMealPlanWeekRequest{ExpectedVersion: before.Version, RequestID: "week_not_enough_candidates"}, pool)
	if !errors.Is(err, errPlanCandidates) {
		t.Fatal(err)
	}
	after, err := readMealPlanWeek(db, start)
	if err != nil || before.Version != after.Version {
		t.Fatal("earlier days were partially committed", err)
	}
	var count int64
	db.Model(&models.ShoppingCheck{}).Count(&count)
	if count != 0 {
		t.Fatal("shopping survived rollback")
	}
}

func TestRealWeekConcurrentDayChangeRejectsWholeRegeneration(t *testing.T) {
	db, start, pool := setupRealWeekTest(t)
	before, _ := readMealPlanWeek(db, start)
	date := start.AddDate(0, 0, 6).Format("2006-01-02")
	_, err := saveMealPlan(date, planTestRequest(t, db, date, "another_page_wrote_sunday", MealPlanDish{DishID: pool.Dinner[2].ID, MealType: "dinner"}))
	if err != nil {
		t.Fatal(err)
	}
	current, _ := readMealPlanWeek(db, start)
	_, err = regenerateMealPlanWeek(start, RegenerateMealPlanWeekRequest{ExpectedVersion: before.Version, RequestID: "week_during_another_edit"}, pool)
	if !errors.Is(err, errMealPlanChanged) {
		t.Fatal(err)
	}
	after, _ := readMealPlanWeek(db, start)
	if current.Version != after.Version {
		t.Fatal("another page's edit was overwritten")
	}
}

func TestWeekStartAcrossYear(t *testing.T) {
	if got := weekStart("2027-01-03").Format("2006-01-02"); got != "2026-12-28" {
		t.Fatal(got)
	}
}
