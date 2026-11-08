package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

func expenseBody(t *testing.T, w *httptest.ResponseRecorder, want int) models.Expense {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status %d, want %d: %s", w.Code, want, w.Body.String())
	}
	var body struct{ Data models.Expense }
	if want == 200 {
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
	}
	return body.Data
}

func TestExpenseLifecycleTotalsAndReplay(t *testing.T) {
	db := setupHandlerTestDB(t, &models.Expense{}, &models.Setting{})
	input := services.ExpenseInput{AmountCents: 10, Category: "ingredients", ExpenseDate: "2026-01-31", Note: "青菜", RequestID: "ledger-request-january"}
	first := expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", input), 200)
	replay := expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", input), 200)
	if replay.ID != first.ID {
		t.Fatal("replay duplicated expense")
	}
	changed := input
	changed.AmountCents = 11
	expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", changed), 409)
	input2 := input
	input2.AmountCents = 20
	input2.RequestID = "ledger-request-january-2"
	expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", input2), 200)
	input3 := input
	input3.AmountCents = 55
	input3.RequestID = "ledger-request-december"
	input3.ExpenseDate = "2025-12-31"
	input3.Category = "takeout"
	expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", input3), 200)
	assertMonth := func(month string, total, previous int64, count int) {
		t.Helper()
		w := serveJSON(t, GetExpenses, "GET", "/expenses?month="+month, nil)
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		var body struct {
			Data struct {
				Total      int64            `json:"total_cents"`
				Previous   int64            `json:"previous_total_cents"`
				Entries    []models.Expense `json:"entries"`
				Categories map[string]int64 `json:"categories"`
			}
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Data.Total != total || body.Data.Previous != previous || len(body.Data.Entries) != count {
			t.Fatalf("wrong monthly totals: %s", w.Body.String())
		}
		var categoryTotal int64
		for _, value := range body.Data.Categories {
			categoryTotal += value
		}
		if categoryTotal != total {
			t.Fatal("category totals differ from month")
		}
	}
	assertMonth("2026-01", 30, 55, 2)
	params := []gin.Param{{Key: "id", Value: fmt.Sprint(first.ID)}}
	update := updateExpenseRequest{ExpenseInput: input, Revision: first.Revision}
	update.ExpenseDate = "2026-02-01"
	update.AmountCents = 99
	update.Category = "other"
	update.Note = ""
	expenseBody(t, serveJSON(t, UpdateExpense, "PUT", "/expenses/1", update, params...), 200)
	expenseBody(t, serveJSON(t, UpdateExpense, "PUT", "/expenses/1", update, params...), 409)
	assertMonth("2026-01", 20, 55, 1)
	assertMonth("2026-02", 99, 20, 1)
	// 旧的新增请求返回现在的账目，不会把用户后来修改的值写回去。
	replay = expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", input), 200)
	if replay.AmountCents != 99 || replay.Note != "" || replay.Revision != 2 {
		t.Fatalf("replay overwrote edit: %+v", replay)
	}
	expenseBody(t, serveJSON(t, DeleteExpense, "DELETE", "/expenses/1", gin.H{"revision": 1}, params...), 409)
	expenseBody(t, serveJSON(t, DeleteExpense, "DELETE", "/expenses/1", gin.H{"revision": 2}, params...), 200)
	assertMonth("2026-02", 0, 20, 0)
	expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", input), 409)
	var count int64
	db.Unscoped().Model(&models.Expense{}).Count(&count)
	if count != 3 {
		t.Fatalf("expected 3 physical rows, got %d", count)
	}
}

func TestExpenseValidationAndBudgetIsolation(t *testing.T) {
	setupHandlerTestDB(t, &models.Expense{}, &models.Setting{})
	base := services.ExpenseInput{AmountCents: 1, Category: "other", ExpenseDate: "2024-02-29", RequestID: "valid-request-123456"}
	for _, modify := range []func(*services.ExpenseInput){
		func(v *services.ExpenseInput) { v.AmountCents = 0 }, func(v *services.ExpenseInput) { v.AmountCents = -1 },
		func(v *services.ExpenseInput) { v.AmountCents = services.MaxExpenseCents + 1 }, func(v *services.ExpenseInput) { v.Category = "unknown" },
		func(v *services.ExpenseInput) { v.ExpenseDate = "2025-02-29" }, func(v *services.ExpenseInput) { v.ExpenseDate = "9999-12-31" },
		func(v *services.ExpenseInput) { v.RequestID = "" },
	} {
		input := base
		modify(&input)
		expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", input), 400)
	}
	expenseBody(t, serveJSON(t, CreateExpense, "POST", "/expenses", gin.H{"amount_cents": 1.5}), 400)
	expenseBody(t, serveJSON(t, GetExpenses, "GET", "/expenses?month=2026-13", nil), 400)
	expenseBody(t, serveJSON(t, GetExpenses, "GET", "/expenses?month=2026-1", nil), 400)
	for _, cents := range []int64{12345, 0} {
		expenseBody(t, serveJSON(t, SetLedgerBudget, "PUT", "/ledger/budget/2026-01", gin.H{"amount_cents": cents}, gin.Param{Key: "month", Value: "2026-01"}), 200)
		for _, month := range []string{"2026-01", "2026-02"} {
			w := serveJSON(t, GetExpenses, "GET", "/expenses?month="+month, nil)
			var body struct {
				Data struct {
					Budget int64 `json:"budget_cents"`
				}
			}
			json.Unmarshal(w.Body.Bytes(), &body)
			want := int64(0)
			if month == "2026-01" {
				want = cents
			}
			if w.Code != 200 || body.Data.Budget != want {
				t.Fatalf("budget isolation failed: %s", w.Body.String())
			}
		}
	}
	expenseBody(t, serveJSON(t, SetLedgerSettings, "PUT", "/ledger/settings", gin.H{"shopping_link_enabled": true}), 200)
	w := serveJSON(t, GetLedgerSettings, "GET", "/ledger/settings", nil)
	var settings struct {
		Data struct {
			Enabled bool `json:"shopping_link_enabled"`
		}
	}
	json.Unmarshal(w.Body.Bytes(), &settings)
	if w.Code != 200 || !settings.Data.Enabled {
		t.Fatal(w.Body.String())
	}
	expenseBody(t, serveJSON(t, SetLedgerBudget, "PUT", "/ledger/budget/2026-01", gin.H{"amount_cents": -1}, gin.Param{Key: "month", Value: "2026-01"}), 400)
}

func TestShoppingExpenseAtomicityAndRetry(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	if err := db.AutoMigrate(&models.Expense{}, &models.ShoppingItemCategory{}); err != nil {
		t.Fatal(err)
	}
	row := models.ShoppingCheck{MealDate: services.TodayDate(), MealType: "extra", ItemName: "记账测试青菜", ItemAmount: "1把"}
	if err := db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	version := currentShoppingDemandVersion(t, row.ItemName)
	input := services.ExpenseInput{AmountCents: 1234, Category: "ingredients", ExpenseDate: services.TodayDate(), RequestID: "shopping-receipt-12345"}
	if err := services.ToggleShoppingCheck(row.ItemName, true, "stale", &input); !errors.Is(err, services.ErrShoppingDemandChanged) {
		t.Fatalf("stale demand: %v", err)
	}
	var count int64
	db.Model(&models.Expense{}).Count(&count)
	if count != 0 {
		t.Fatal("failed purchase left expense")
	}
	// 支出已插入后采购写入失败，事务也必须撤回支出。
	failUpdate := true
	db.Callback().Update().Before("gorm:update").Register("test:purchase-write-failure", func(tx *gorm.DB) {
		if failUpdate && tx.Statement.Table == "shopping_checks" {
			tx.AddError(errors.New("test failure"))
		}
	})
	if err := services.ToggleShoppingCheck(row.ItemName, true, version, &input); err == nil {
		t.Fatal("expected failed write")
	}
	db.Model(&models.Expense{}).Count(&count)
	if count != 0 {
		t.Fatal("rollback did not remove expense")
	}
	failUpdate = false
	if err := services.ToggleShoppingCheck(row.ItemName, true, version, &input); err != nil {
		t.Fatal(err)
	}
	if err := services.ToggleShoppingCheck(row.ItemName, true, version, &input); err != nil {
		t.Fatalf("retry: %v", err)
	}
	db.Model(&models.Expense{}).Count(&count)
	if count != 1 {
		t.Fatal("duplicate receipt")
	}
	second := input
	second.RequestID = "shopping-new-request-12345"
	if err := services.ToggleShoppingCheck(row.ItemName, true, currentShoppingDemandVersion(t, row.ItemName), &second); !errors.Is(err, services.ErrShoppingAlreadyPurchased) {
		t.Fatalf("fresh duplicate: %v", err)
	}
	if err := services.ToggleShoppingCheck(row.ItemName, false, currentShoppingDemandVersion(t, row.ItemName)); err != nil {
		t.Fatal(err)
	}
	db.Model(&models.Expense{}).Count(&count)
	if count != 1 {
		t.Fatal("uncheck must retain actual expense")
	}
	if err := services.ToggleShoppingCheck(row.ItemName, true, version, &input); err != nil {
		t.Fatal(err)
	}
	db.First(&row, row.ID)
	if row.Checked {
		t.Fatal("replay must not recheck after a later undo")
	}
}
