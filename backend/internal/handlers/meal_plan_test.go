package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"ninimenu/internal/models"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func setupMealPlanTest(t *testing.T) (*gorm.DB, string, []models.Dish) {
	t.Helper()
	db := setupRecordLifecycleDB(t)
	if err := db.AutoMigrate(&models.Setting{}); err != nil {
		t.Fatal(err)
	}
	dishes := []models.Dish{}
	for i := range 4 {
		dish := models.Dish{Name: fmt.Sprintf("菜%d", i), Enabled: true, Ingredients: fmt.Sprintf(`[{"name":"食材%d","amount":"200克"}]`, i)}
		if err := db.Create(&dish).Error; err != nil {
			t.Fatal(err)
		}
		dishes = append(dishes, dish)
	}
	return db, time.Now().AddDate(0, 0, 1).Format("2006-01-02"), dishes
}

func planTestSnapshot(t *testing.T, db *gorm.DB, date string) MealPlanSnapshot {
	t.Helper()
	snapshot, _, err := readMealPlanSnapshot(db, date)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func planTestRequest(t *testing.T, db *gorm.DB, date, id string, dishes ...MealPlanDish) SaveMealPlanRequest {
	t.Helper()
	return SaveMealPlanRequest{ExpectedVersion: planTestSnapshot(t, db, date).Version, RequestID: id, Dishes: dishes}
}

func TestAtomicMealPlanPreservesKeptAndRestoredShopping(t *testing.T) {
	db, date, dishes := setupMealPlanTest(t)
	create := func(dish models.Dish, meal string) models.MealRecord {
		return testCreateMeal(t, CreateRecordRequest{DishID: dish.ID, DishName: dish.Name, MealDate: date, MealType: meal})
	}
	keep := create(dishes[0], "lunch")
	remove := create(dishes[1], "lunch")
	restore := create(dishes[2], "dinner")
	db.Model(&keep).Update("portion_scale", 2)
	var keepItem, restoreItem models.ShoppingCheck
	db.Where("dish_id = ?", keep.DishID).First(&keepItem)
	db.Model(&keepItem).Updates(map[string]any{"checked": true, "stocked": true, "item_amount": "400克", "base_amount": "200克"})
	db.Where("dish_id = ?", restore.DishID).First(&restoreItem)
	db.Model(&restoreItem).Updates(map[string]any{"checked": true, "stocked": true})
	before := restore
	restore.Status = models.MealCancelled
	db.Save(&restore)
	if err := syncRecordShopping(db, before, restore); err != nil {
		t.Fatal(err)
	}
	req := planTestRequest(t, db, date, "request_preserve_0001", MealPlanDish{keep.DishID, "lunch", nil}, MealPlanDish{restore.DishID, "dinner", nil}, MealPlanDish{dishes[3].ID, "dinner", nil})
	result, err := saveMealPlan(date, req)
	if err != nil || len(result.Records) != 3 {
		t.Fatalf("save: %+v %v", result, err)
	}
	db.First(&keep, keep.ID)
	db.First(&restore, restore.ID)
	db.First(&remove, remove.ID)
	db.First(&keepItem, keepItem.ID)
	db.First(&restoreItem, restoreItem.ID)
	if keep.PortionScale != 2 || !keepItem.Checked || !keepItem.Stocked || keepItem.ItemAmount != "400克" || restore.Status != models.MealPlanned || !restoreItem.Checked || !restoreItem.Stocked {
		t.Fatalf("identity/shopping lost: %+v %+v %+v %+v", keep, keepItem, restore, restoreItem)
	}
	if remove.Status != models.MealCancelled {
		t.Fatal("removed meal was not cancelled")
	}
	var hidden models.ShoppingCheck
	db.Unscoped().Where("dish_id = ?", remove.DishID).First(&hidden)
	if !hidden.DeletedAt.Valid {
		t.Fatal("removed meal still has visible shopping")
	}
}

func TestAtomicMealPlanRejectsChangedBaselines(t *testing.T) {
	for _, change := range []string{"rescheduled", "completed", "added", "portion", "cancelled"} {
		t.Run(change, func(t *testing.T) {
			db, date, dishes := setupMealPlanTest(t)
			record := testCreateMeal(t, CreateRecordRequest{DishID: dishes[0].ID, DishName: dishes[0].Name, MealDate: date, MealType: "lunch"})
			req := planTestRequest(t, db, date, "request_stale_0001", MealPlanDish{dishes[1].ID, "dinner", nil})
			switch change {
			case "rescheduled":
				db.Model(&record).Update("meal_date", time.Now().AddDate(0, 0, 7).Format("2006-01-02"))
			case "completed":
				db.Model(&record).Update("status", models.MealCompleted)
			case "added":
				testCreateMeal(t, CreateRecordRequest{DishID: dishes[2].ID, DishName: dishes[2].Name, MealDate: date, MealType: "lunch"})
			case "portion":
				db.Model(&record).Update("portion_scale", 3)
			case "cancelled":
				db.Model(&record).Update("status", models.MealCancelled)
			}
			latest := planTestSnapshot(t, db, date)
			_, err := saveMealPlan(date, req)
			if !errors.Is(err, errMealPlanChanged) {
				t.Fatalf("stale %s request accepted: %v", change, err)
			}
			if got := planTestSnapshot(t, db, date); got.Version != latest.Version {
				t.Fatal("rejected save changed current plans")
			}
			var moved models.MealRecord
			db.First(&moved, record.ID)
			if change == "rescheduled" && moved.Status != models.MealPlanned {
				t.Fatal("old date save cancelled moved record")
			}
		})
	}
}

func TestAtomicMealPlanRollbackAndSafeResponseRetry(t *testing.T) {
	db, date, dishes := setupMealPlanTest(t)
	original := testCreateMeal(t, CreateRecordRequest{DishID: dishes[0].ID, DishName: dishes[0].Name, MealDate: date, MealType: "lunch"})
	req := planTestRequest(t, db, date, "request_retry_0001", MealPlanDish{dishes[1].ID, "dinner", nil})
	before := planTestSnapshot(t, db, date)
	// Fail after the new dish and shopping rows have already been inserted.
	db.Exec("CREATE TRIGGER fail_plan_cancel BEFORE UPDATE OF status ON meal_records WHEN NEW.status = 'cancelled' BEGIN SELECT RAISE(ABORT, 'blocked'); END")
	if _, err := saveMealPlan(date, req); err == nil {
		t.Fatal("expected injected error")
	}
	if got := planTestSnapshot(t, db, date); got.Version != before.Version {
		t.Fatal("failed replacement did not roll back all meal rows")
	}
	var count int64
	db.Model(&models.ShoppingCheck{}).Count(&count)
	if count != 1 {
		t.Fatalf("failed replacement left new shopping rows: %d", count)
	}
	db.Exec("DROP TRIGGER fail_plan_cancel")
	first, err := saveMealPlan(date, req)
	if err != nil {
		t.Fatal(err)
	}
	second, err := saveMealPlan(date, req)
	if err != nil || !second.Replayed || second.Version != first.Version || second.Records[0].ID != first.Records[0].ID {
		t.Fatalf("lost response retry: %+v %v", second, err)
	}
	reused := req
	reused.Dishes = []MealPlanDish{{dishes[2].ID, "lunch", nil}}
	if _, err := saveMealPlan(date, reused); !errors.Is(err, errMealPlanChanged) {
		t.Fatal("same request id accepted different intent")
	}
	db.Model(&models.MealRecord{}).Where("id = ?", first.Records[0].ID).Update("portion_scale", 2)
	if _, err := saveMealPlan(date, req); !errors.Is(err, errMealPlanChanged) {
		t.Fatal("old retry concealed subsequent change")
	}
	db.First(&original, original.ID)
	if original.Status != models.MealCancelled {
		t.Fatal("cancelled original unexpectedly restored")
	}
}

func TestAtomicMealPlanReceiptFailureRollsBackAndSnapshotIsComplete(t *testing.T) {
	db, date, dishes := setupMealPlanTest(t)
	req := planTestRequest(t, db, date, "request_receipt_0001", MealPlanDish{dishes[0].ID, "lunch", nil})
	db.Exec("CREATE TRIGGER fail_plan_receipt BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'blocked'); END")
	if _, err := saveMealPlan(date, req); err == nil {
		t.Fatal("expected receipt failure")
	}
	if got := planTestSnapshot(t, db, date); len(got.Records) != 0 {
		t.Fatal("receipt failure left partial plans")
	}
	db.Exec("DROP TRIGGER fail_plan_receipt")
	for i := 0; i < 105; i++ {
		db.Create(&models.MealRecord{DishID: uint(1000 + i), DishName: "历史导入菜", MealDate: date, MealType: "lunch", Status: models.MealPlanned})
	}
	snapshot := planTestSnapshot(t, db, date)
	if len(snapshot.Records) != 105 {
		t.Fatalf("full day snapshot truncated at %d", len(snapshot.Records))
	}
	w := serveJSON(t, GetMealPlan, "GET", "/meal-plans/"+date, nil, gin.Param{Key: "date", Value: date})
	if w.Code != 200 {
		t.Fatalf("get snapshot: %s", w.Body.String())
	}
}

func TestAtomicMealPlanHTTPValidationAndConflict(t *testing.T) {
	db, date, dishes := setupMealPlanTest(t)
	params := []gin.Param{{Key: "date", Value: date}}
	req := planTestRequest(t, db, date, "request_http_0001", MealPlanDish{dishes[0].ID, "lunch", nil})
	for _, invalid := range []any{
		map[string]any{"expected_version": req.ExpectedVersion, "request_id": req.RequestID},
		SaveMealPlanRequest{ExpectedVersion: req.ExpectedVersion, RequestID: "short", Dishes: []MealPlanDish{}},
		SaveMealPlanRequest{ExpectedVersion: req.ExpectedVersion, RequestID: req.RequestID, Dishes: []MealPlanDish{{dishes[0].ID, "lunch", nil}, {dishes[0].ID, "lunch", nil}}},
		SaveMealPlanRequest{ExpectedVersion: req.ExpectedVersion, RequestID: req.RequestID, Dishes: []MealPlanDish{{dishes[0].ID, "breakfast", nil}}},
	} {
		w := serveJSON(t, SaveMealPlan, "PUT", "/meal-plans/"+date, invalid, params...)
		if w.Code != 400 {
			t.Fatalf("invalid request should fail: %d %s", w.Code, w.Body.String())
		}
	}
	w := serveJSON(t, SaveMealPlan, "PUT", "/meal-plans/"+date, req, params...)
	if w.Code != 200 {
		t.Fatalf("valid atomic save: %d %s", w.Code, w.Body.String())
	}
	var response struct {
		Data MealPlanSnapshot `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || len(response.Data.Records) != 1 {
		t.Fatalf("invalid snapshot response: %s", w.Body.String())
	}
	req.RequestID = "another_request_0001"
	w = serveJSON(t, SaveMealPlan, "PUT", "/meal-plans/"+date, req, params...)
	if w.Code != 409 {
		t.Fatalf("old baseline needs 409: %d %s", w.Code, w.Body.String())
	}
	w = serveJSON(t, SaveMealPlan, "PUT", "/meal-plans/2000-01-01", req, gin.Param{Key: "date", Value: "2000-01-01"})
	if w.Code != 409 {
		t.Fatalf("expired target date needs 409: %d %s", w.Code, w.Body.String())
	}
}

func TestAtomicMealPlanConcurrentSavesCannotMergeDifferentIntents(t *testing.T) {
	db, date, dishes := setupMealPlanTest(t)
	db.Exec("PRAGMA journal_mode = WAL")
	db.Exec("PRAGMA busy_timeout = 5000")
	first := planTestRequest(t, db, date, "concurrent_save_0001", MealPlanDish{dishes[0].ID, "lunch", nil})
	second := planTestRequest(t, db, date, "concurrent_save_0002", MealPlanDish{dishes[1].ID, "dinner", nil})
	start := make(chan struct{})
	errorsCh := make(chan error, 2)
	var wg sync.WaitGroup
	for _, req := range []SaveMealPlanRequest{first, second} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := saveMealPlan(date, req)
			errorsCh <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errorsCh)
	succeeded := 0
	for err := range errorsCh {
		if err == nil {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("expected exactly one winner, got %d", succeeded)
	}
	snapshot := planTestSnapshot(t, db, date)
	if len(snapshot.Records) != 1 {
		t.Fatalf("concurrent saves merged incompatible menus: %+v", snapshot.Records)
	}
}

func TestAtomicMealPlanValidatesRestoredDishesButPreservesExistingPlans(t *testing.T) {
	for _, availability := range []string{"disabled", "deleted"} {
		for _, status := range []string{models.MealPlanned, models.MealCancelled} {
			t.Run(availability+"/"+status, func(t *testing.T) {
				db, date, dishes := setupMealPlanTest(t)
				record := testCreateMeal(t, CreateRecordRequest{DishID: dishes[0].ID, DishName: dishes[0].Name, MealDate: date, MealType: "lunch"})
				if err := db.Model(&record).Update("status", status).Error; err != nil {
					t.Fatal(err)
				}
				if availability == "disabled" {
					if err := db.Model(&dishes[0]).Update("enabled", false).Error; err != nil {
						t.Fatal(err)
					}
				} else if err := db.Delete(&dishes[0]).Error; err != nil {
					t.Fatal(err)
				}
				before := planTestSnapshot(t, db, date)
				req := planTestRequest(t, db, date, "request_unavailable_0001", MealPlanDish{dishes[0].ID, "lunch", nil})
				result, err := saveMealPlan(date, req)
				if status == models.MealCancelled {
					if !errors.Is(err, errMealPlanChanged) || planTestSnapshot(t, db, date).Version != before.Version {
						t.Fatalf("restored unavailable dish: %+v %v", result, err)
					}
				} else if err != nil || result.Version != before.Version || len(result.Records) != 1 || result.Records[0].ID != record.ID {
					t.Fatalf("existing plan should stay intact: %+v %v", result, err)
				}
			})
		}
	}
}

func TestAtomicMealPlanShoppingDishReadFailureRollsBack(t *testing.T) {
	db, date, dishes := setupMealPlanTest(t)
	req := planTestRequest(t, db, date, "request_dish_read_0001", MealPlanDish{dishes[0].ID, "lunch", nil})
	before := planTestSnapshot(t, db, date)
	injected := errors.New("injected shopping dish read failure")
	const callback = "test:fail_shopping_dish_read"
	if err := db.Callback().Query().Before("gorm:query").Register(callback, func(tx *gorm.DB) {
		// saveMealPlan's validation is scoped. The subsequent shopping lookup is not.
		if tx.Statement.Table == "dishes" && tx.Statement.Unscoped {
			tx.AddError(injected)
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Callback().Query().Remove(callback) })
	if _, err := saveMealPlan(date, req); !errors.Is(err, injected) {
		t.Fatalf("shopping dish read failure was ignored: %v", err)
	}
	if got := planTestSnapshot(t, db, date); got.Version != before.Version {
		t.Fatal("failed shopping lookup left a committed meal")
	}
	for _, model := range []any{&models.ShoppingCheck{}, &models.Setting{}} {
		var count int64
		if err := db.Model(model).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("failed save left shopping rows or receipt: count=%d error=%v", count, err)
		}
	}
}
