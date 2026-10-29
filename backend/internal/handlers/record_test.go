package handlers

import (
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
)

func TestAddShoppingItemsLegacyStringArrays(t *testing.T) {
	db := setupHandlerTestDB(t, &models.Dish{}, &models.ShoppingCheck{})
	// 旧数据：食材是字符串数组，调料是对象数组
	dish := models.Dish{Name: "番茄炒蛋", Ingredients: `["番茄","鸡蛋"]`, Seasonings: `[{"name":"盐","amount":"少许"}]`}
	db.Create(&dish)

	if err := addShoppingItems(db, dish.ID, dish.Name, "lunch", "2026-10-28"); err != nil {
		t.Fatal(err)
	}
	var rows []models.ShoppingCheck
	db.Order("id ASC").Find(&rows)
	if len(rows) != 3 || rows[0].ItemName != "番茄" || rows[1].ItemName != "鸡蛋" || rows[2].ItemName != "盐" || rows[2].ItemAmount != "少许" {
		t.Fatalf("旧格式食材也应写入买菜清单, got %+v", rows)
	}
}

func TestBatchCreateRecordsReportsFailure(t *testing.T) {
	// 故意不建 shopping_checks 表：买菜清单联动写入失败，整条记录事务回滚
	setupHandlerTestDB(t, &models.Dish{}, &models.MealRecord{})
	dish := models.Dish{Name: "番茄炒蛋", Ingredients: `["番茄"]`, Enabled: true}
	database.DB.Create(&dish)

	w := serveJSON(t, BatchCreateRecords, "POST", "/api/records/batch", map[string]any{
		"records": []map[string]any{{"dish_id": dish.ID, "dish_name": dish.Name, "meal_type": "lunch", "meal_date": "2026-10-28"}},
	})
	if w.Code != 500 {
		t.Fatalf("一条都没写进去时应返回 500 而不是\"已记录\", got %d %s", w.Code, w.Body.String())
	}
	var n int64
	database.DB.Model(&models.MealRecord{}).Count(&n)
	if n != 0 {
		t.Fatalf("失败的记录应随事务回滚, got %d", n)
	}
}
