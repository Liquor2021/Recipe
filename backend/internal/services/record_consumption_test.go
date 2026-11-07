package services

import (
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"
)

func setupRecordConsumptionTest(t *testing.T) models.MealRecord {
	t.Helper()
	setupTestDB(t, &models.MealRecord{}, &models.InventoryBatch{}, &models.RecordConsumption{})
	record := models.MealRecord{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: TodayDate(), Status: models.MealCompleted}
	if err := database.DB.Create(&record).Error; err != nil {
		t.Fatal(err)
	}
	return record
}

func consumptionTestBatch(t *testing.T, name, quantity string) models.InventoryBatch {
	t.Helper()
	batch := models.InventoryBatch{ItemName: name, InStock: true, Quantity: quantity, ExpiryDate: "2030-01-20"}
	if err := database.DB.Create(&batch).Error; err != nil {
		t.Fatal(err)
	}
	return batch
}

func expectedConsumptionBatches(batches ...models.InventoryBatch) []ExpectedConsumptionBatch {
	expected := make([]ExpectedConsumptionBatch, 0, len(batches))
	for _, batch := range batches {
		expected = append(expected, ExpectedConsumptionBatch{BatchID: batch.ID, Quantity: batch.Quantity, UpdatedAt: batch.UpdatedAt})
	}
	return expected
}

func loadConsumptionBatch(t *testing.T, id uint) models.InventoryBatch {
	t.Helper()
	var batch models.InventoryBatch
	if err := database.DB.First(&batch, id).Error; err != nil {
		t.Fatal(err)
	}
	return batch
}

func assertConsumptionInputError(t *testing.T, err error) {
	t.Helper()
	var inputError *ConsumptionInputError
	if !errors.As(err, &inputError) {
		t.Fatalf("expected recoverable input/conflict error, got %v", err)
	}
}

func activeConsumptionEntry(t *testing.T, recordID uint) uint {
	t.Helper()
	history, err := GetRecordConsumptionHistory(recordID)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range history.Entries {
		if entry.Status == models.ConsumptionApplied {
			return entry.ID
		}
	}
	t.Fatal("expected an active consumption entry")
	return 0
}

func TestRecordConsumptionApplyUndoAndReapply(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	tomato := consumptionTestBatch(t, "番茄", "1000克")
	egg := consumptionTestBatch(t, "鸡蛋", "3个")
	result, err := ApplyRecordConsumption(record.ID, []uint{egg.ID}, []BatchRemaining{{BatchID: tomato.ID, Quantity: "600克"}}, expectedConsumptionBatches(tomato, egg))
	if err != nil || result.Removed != 1 || result.Updated != 1 || !result.Applied {
		t.Fatalf("consume failed: %+v %v", result, err)
	}
	if got := loadConsumptionBatch(t, tomato.ID); got.Quantity != "600克" {
		t.Fatalf("incorrect remaining quantity: %+v", got)
	}
	if err := database.DB.First(&models.InventoryBatch{}, egg.ID).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("finished batch should be removed: %v", err)
	}
	history, err := GetRecordConsumptionHistory(record.ID)
	if err != nil || !history.Applied || len(history.Entries) != 1 || len(history.Entries[0].Items) != 2 {
		t.Fatalf("missing history: %+v %v", history, err)
	}
	if history.Entries[0].Items[0].BeforeQuantity != "1000克" || history.Entries[0].Items[0].AfterQuantity != "600克" || !history.Entries[0].Items[1].Removed {
		t.Fatalf("wrong history values: %+v", history.Entries[0].Items)
	}
	_, err = ApplyRecordConsumption(record.ID, []uint{tomato.ID}, nil, expectedConsumptionBatches(loadConsumptionBatch(t, tomato.ID)))
	assertConsumptionInputError(t, err)
	if got := loadConsumptionBatch(t, tomato.ID); got.Quantity != "600克" {
		t.Fatal("repeat submission changed inventory")
	}
	entryID := history.Entries[0].ID
	for range 2 {
		if err := RevertRecordConsumption(record.ID, entryID); err != nil {
			t.Fatal(err)
		}
	}
	if got := loadConsumptionBatch(t, tomato.ID); !sameInventorySnapshot(got, tomato) {
		t.Fatalf("partial batch was not fully restored: %+v", got)
	}
	if got := loadConsumptionBatch(t, egg.ID); !sameInventorySnapshot(got, egg) {
		t.Fatalf("removed batch was not fully restored: %+v", got)
	}
	history, err = GetRecordConsumptionHistory(record.ID)
	if err != nil || history.Applied || history.Entries[0].Status != models.ConsumptionReverted || history.Entries[0].RevertedAt == nil {
		t.Fatalf("undo log missing: %+v %v", history, err)
	}
	if _, err := ApplyRecordConsumption(record.ID, []uint{egg.ID}, nil, expectedConsumptionBatches(egg)); err != nil {
		t.Fatal(err)
	}
	history, err = GetRecordConsumptionHistory(record.ID)
	if err != nil || !history.Applied || len(history.Entries) != 2 || history.Entries[1].Status != models.ConsumptionReverted {
		t.Fatalf("reapply should preserve undo history: %+v %v", history, err)
	}
}

func TestRecordConsumptionRequiresCurrentSnapshots(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	batch := consumptionTestBatch(t, "番茄", "1000克")
	remaining := []BatchRemaining{{BatchID: batch.ID, Quantity: "600克"}}
	_, err := ApplyRecordConsumption(record.ID, nil, remaining, nil)
	assertConsumptionInputError(t, err)
	if err := database.DB.Model(&batch).Update("quantity", "800克").Error; err != nil {
		t.Fatal(err)
	}
	// GORM updated the local struct too; explicitly model the old page's snapshot.
	stale := ExpectedConsumptionBatch{BatchID: batch.ID, Quantity: "1000克", UpdatedAt: batch.CreatedAt}
	_, err = ApplyRecordConsumption(record.ID, nil, remaining, []ExpectedConsumptionBatch{stale})
	assertConsumptionInputError(t, err)
	if got := loadConsumptionBatch(t, batch.ID); got.Quantity != "800克" {
		t.Fatal("stale page overwrote later inventory")
	}
	var persisted models.MealRecord
	database.DB.First(&persisted, record.ID)
	if persisted.InventoryApplied {
		t.Fatal("rejected stale request must roll back applied flag")
	}
	history, err := GetRecordConsumptionHistory(record.ID)
	if err != nil || len(history.Entries) != 0 {
		t.Fatalf("rejected request left receipt: %+v %v", history, err)
	}
	current := loadConsumptionBatch(t, batch.ID)
	if _, err := ApplyRecordConsumption(record.ID, nil, remaining, expectedConsumptionBatches(current)); err != nil {
		t.Fatal(err)
	}
}

func TestRecordConsumptionValidationIsAtomic(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	batch := consumptionTestBatch(t, "番茄", "1000克")
	cases := []struct {
		remove    []uint
		remaining []BatchRemaining
		expected  []ExpectedConsumptionBatch
	}{
		{},
		{remove: []uint{batch.ID, batch.ID}, expected: expectedConsumptionBatches(batch)},
		{remove: []uint{batch.ID}, remaining: []BatchRemaining{{BatchID: batch.ID, Quantity: "500克"}}, expected: expectedConsumptionBatches(batch)},
		{remaining: []BatchRemaining{{BatchID: batch.ID, Quantity: " "}}, expected: expectedConsumptionBatches(batch)},
		{remove: []uint{batch.ID}, expected: append(expectedConsumptionBatches(batch), expectedConsumptionBatches(batch)...)},
		{remove: []uint{batch.ID, batch.ID + 100}, expected: append(expectedConsumptionBatches(batch), ExpectedConsumptionBatch{BatchID: batch.ID + 100, UpdatedAt: time.Now()})},
	}
	for _, tc := range cases {
		_, err := ApplyRecordConsumption(record.ID, tc.remove, tc.remaining, tc.expected)
		assertConsumptionInputError(t, err)
		if got := loadConsumptionBatch(t, batch.ID); !sameInventorySnapshot(got, batch) {
			t.Fatal("invalid request changed existing batch")
		}
	}
	var persisted models.MealRecord
	database.DB.First(&persisted, record.ID)
	if persisted.InventoryApplied {
		t.Fatal("invalid request changed record flag")
	}
}

func TestRecordConsumptionOnlyCompletedPastOrToday(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	batch := consumptionTestBatch(t, "番茄", "1000克")
	for _, tc := range []struct{ status, date string }{
		{models.MealPlanned, TodayDate()}, {models.MealCancelled, TodayDate()},
		{models.MealCompleted, time.Now().AddDate(0, 0, 1).Format("2006-01-02")},
	} {
		if err := database.DB.Model(&record).Updates(map[string]any{"status": tc.status, "meal_date": tc.date}).Error; err != nil {
			t.Fatal(err)
		}
		_, err := ApplyRecordConsumption(record.ID, []uint{batch.ID}, nil, expectedConsumptionBatches(batch))
		assertConsumptionInputError(t, err)
	}
	if _, err := ApplyRecordConsumption(record.ID+100, []uint{batch.ID}, nil, expectedConsumptionBatches(batch)); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("missing record: %v", err)
	}
	loadConsumptionBatch(t, batch.ID)
}

func TestRecordConsumptionUndoInReverseOrder(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	second := models.MealRecord{DishID: 2, DishName: "番茄汤", MealType: "dinner", MealDate: TodayDate(), Status: models.MealCompleted}
	database.DB.Create(&second)
	tomato := consumptionTestBatch(t, "番茄", "1000克")
	egg := consumptionTestBatch(t, "鸡蛋", "3个")
	if _, err := ApplyRecordConsumption(record.ID, []uint{egg.ID}, []BatchRemaining{{BatchID: tomato.ID, Quantity: "800克"}}, expectedConsumptionBatches(tomato, egg)); err != nil {
		t.Fatal(err)
	}
	firstEntryID := activeConsumptionEntry(t, record.ID)
	current := loadConsumptionBatch(t, tomato.ID)
	if _, err := ApplyRecordConsumption(second.ID, nil, []BatchRemaining{{BatchID: tomato.ID, Quantity: "600克"}}, expectedConsumptionBatches(current)); err != nil {
		t.Fatal(err)
	}
	secondEntryID := activeConsumptionEntry(t, second.ID)
	assertConsumptionInputError(t, RevertRecordConsumption(record.ID, firstEntryID))
	if got := loadConsumptionBatch(t, tomato.ID); got.Quantity != "600克" {
		t.Fatal("undo overwrote subsequent consumption")
	}
	if err := database.DB.First(&models.InventoryBatch{}, egg.ID).Error; !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatal("conflicted undo partially restored a different batch")
	}
	history, _ := GetRecordConsumptionHistory(record.ID)
	if !history.Applied || history.Entries[0].Status != models.ConsumptionApplied {
		t.Fatal("conflicted undo modified receipt or flag")
	}
	if err := RevertRecordConsumption(second.ID, secondEntryID); err != nil {
		t.Fatal(err)
	}
	if err := RevertRecordConsumption(record.ID, firstEntryID); err != nil {
		t.Fatal(err)
	}
	if got := loadConsumptionBatch(t, tomato.ID); !sameInventorySnapshot(got, tomato) {
		t.Fatalf("reverse order did not restore original: %+v", got)
	}
	loadConsumptionBatch(t, egg.ID)
}

func TestRecordConsumptionUndoRejectsMetadataChangesAndIDReuse(t *testing.T) {
	for _, fullRemoval := range []bool{false, true} {
		t.Run(map[bool]string{false: "metadata", true: "id_reuse"}[fullRemoval], func(t *testing.T) {
			record := setupRecordConsumptionTest(t)
			batch := consumptionTestBatch(t, "番茄", "1000克")
			var err error
			if fullRemoval {
				_, err = ApplyRecordConsumption(record.ID, []uint{batch.ID}, nil, expectedConsumptionBatches(batch))
			} else {
				_, err = ApplyRecordConsumption(record.ID, nil, []BatchRemaining{{BatchID: batch.ID, Quantity: "600克"}}, expectedConsumptionBatches(batch))
			}
			if err != nil {
				t.Fatal(err)
			}
			if fullRemoval {
				replacement := models.InventoryBatch{ID: batch.ID, ItemName: "后买的番茄", InStock: true, Quantity: "2个"}
				err = database.DB.Create(&replacement).Error
			} else {
				err = database.DB.Model(&models.InventoryBatch{}).Where("id = ?", batch.ID).Update("expiry_date", "2030-12-31").Error
			}
			if err != nil {
				t.Fatal(err)
			}
			assertConsumptionInputError(t, RevertRecordConsumption(record.ID, activeConsumptionEntry(t, record.ID)))
		})
	}
}

func TestRecordConsumptionRollbackIfReceiptSaveFails(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	tomato := consumptionTestBatch(t, "番茄", "1000克")
	egg := consumptionTestBatch(t, "鸡蛋", "3个")
	if err := database.DB.Exec("CREATE TRIGGER reject_consumption_receipt BEFORE INSERT ON record_consumptions BEGIN SELECT RAISE(ABORT, 'blocked'); END").Error; err != nil {
		t.Fatal(err)
	}
	_, err := ApplyRecordConsumption(record.ID, []uint{egg.ID}, []BatchRemaining{{BatchID: tomato.ID, Quantity: "600克"}}, expectedConsumptionBatches(tomato, egg))
	if err == nil {
		t.Fatal("expected receipt storage failure")
	}
	if got := loadConsumptionBatch(t, tomato.ID); !sameInventorySnapshot(got, tomato) {
		t.Fatal("partial quantity not rolled back")
	}
	loadConsumptionBatch(t, egg.ID)
	var persisted models.MealRecord
	database.DB.First(&persisted, record.ID)
	if persisted.InventoryApplied {
		t.Fatal("record flag not rolled back")
	}
}

func TestRecordConsumptionUndoCompletionIsAtomic(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	database.DB.Model(&record).Updates(map[string]any{"rating": 5, "mood": "yum", "photo": "/uploads/food.jpg", "remark": "保留备注", "portion_scale": 2})
	batch := consumptionTestBatch(t, "番茄", "1000克")
	if _, err := ApplyRecordConsumption(record.ID, nil, []BatchRemaining{{BatchID: batch.ID, Quantity: "600克"}}, expectedConsumptionBatches(batch)); err != nil {
		t.Fatal(err)
	}
	entryID := activeConsumptionEntry(t, record.ID)
	// A storage error on the final meal update must also roll back the inventory restoration.
	if err := database.DB.Exec("CREATE TRIGGER reject_uncomplete BEFORE UPDATE OF status ON meal_records WHEN NEW.status = 'planned' BEGIN SELECT RAISE(ABORT, 'blocked'); END").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := RevertMealCompletion(record.ID, &entryID); err == nil {
		t.Fatal("expected meal rollback failure")
	}
	if got := loadConsumptionBatch(t, batch.ID); got.Quantity != "600克" {
		t.Fatal("inventory restoration did not roll back with record")
	}
	database.DB.Exec("DROP TRIGGER reject_uncomplete")
	got, err := RevertMealCompletion(record.ID, &entryID)
	if err != nil || got.Status != models.MealPlanned || got.InventoryApplied || got.Rating != 0 || got.Mood != "" || got.Photo != "" || got.Remark != "保留备注" || got.PortionScale != 2 {
		t.Fatalf("undo completion wrong result: %+v %v", got, err)
	}
	if restored := loadConsumptionBatch(t, batch.ID); !sameInventorySnapshot(restored, batch) {
		t.Fatal("undo completion failed to restore inventory")
	}
	if _, err := RevertMealCompletion(record.ID, &entryID); err != nil {
		t.Fatalf("repeat undo should be harmless: %v", err)
	}
}

func TestRecordConsumptionStaleUndoCannotRevertNewEntry(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	batch := consumptionTestBatch(t, "番茄", "1000克")
	if _, err := ApplyRecordConsumption(record.ID, nil, []BatchRemaining{{BatchID: batch.ID, Quantity: "600克"}}, expectedConsumptionBatches(batch)); err != nil {
		t.Fatal(err)
	}
	firstEntry := activeConsumptionEntry(t, record.ID)
	if err := RevertRecordConsumption(record.ID, firstEntry); err != nil {
		t.Fatal(err)
	}
	if err := RevertRecordConsumption(record.ID, firstEntry); err != nil {
		t.Fatalf("same entry retry should be idempotent: %v", err)
	}
	current := loadConsumptionBatch(t, batch.ID)
	if _, err := ApplyRecordConsumption(record.ID, nil, []BatchRemaining{{BatchID: batch.ID, Quantity: "500克"}}, expectedConsumptionBatches(current)); err != nil {
		t.Fatal(err)
	}
	secondEntry := activeConsumptionEntry(t, record.ID)
	assertConsumptionInputError(t, RevertRecordConsumption(record.ID, firstEntry))
	_, err := RevertMealCompletion(record.ID, &firstEntry)
	assertConsumptionInputError(t, err)
	_, err = RevertMealCompletion(record.ID, nil)
	assertConsumptionInputError(t, err)
	if got := loadConsumptionBatch(t, batch.ID); got.Quantity != "500克" {
		t.Fatal("stale undo reverted newer inventory")
	}
	var persisted models.MealRecord
	database.DB.First(&persisted, record.ID)
	if !persisted.InventoryApplied || persisted.Status != models.MealCompleted || activeConsumptionEntry(t, record.ID) != secondEntry {
		t.Fatal("stale undo changed active receipt or meal state")
	}
	if _, err := RevertMealCompletion(record.ID, &secondEntry); err != nil {
		t.Fatal(err)
	}
	if got := loadConsumptionBatch(t, batch.ID); got.Quantity != "1000克" {
		t.Fatal("confirmed new entry did not restore original inventory")
	}
}

func TestRecordConsumptionUndoCompletionWithoutInventory(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	got, err := RevertMealCompletion(record.ID, nil)
	if err != nil || got.Status != models.MealPlanned {
		t.Fatalf("explicit no-inventory confirmation failed: %+v %v", got, err)
	}
	invalidEntry := uint(1234)
	_, err = RevertMealCompletion(record.ID, &invalidEntry)
	assertConsumptionInputError(t, err)
}

func TestRecordConsumptionConcurrentSubmissionAtMostOnce(t *testing.T) {
	record := setupRecordConsumptionTest(t)
	batch := consumptionTestBatch(t, "番茄", "1000克")
	start := make(chan struct{})
	errorsCh := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := ApplyRecordConsumption(record.ID, nil, []BatchRemaining{{BatchID: batch.ID, Quantity: "600克"}}, expectedConsumptionBatches(batch))
			errorsCh <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errorsCh)
	successes := 0
	for err := range errorsCh {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("expected one successful concurrent submission, got %d", successes)
	}
	history, err := GetRecordConsumptionHistory(record.ID)
	if err != nil || len(history.Entries) != 1 || !history.Applied {
		t.Fatalf("duplicate receipt: %+v %v", history, err)
	}
}
