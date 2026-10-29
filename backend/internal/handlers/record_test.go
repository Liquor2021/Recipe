package handlers

import (
	"encoding/json"
	"fmt"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestAddShoppingItemsLegacyStringArrays(t *testing.T) {
	db := setupHandlerTestDB(t, &models.Dish{}, &models.ShoppingCheck{})
	// 旧数据：食材是字符串数组，调料是对象数组；调料里的清水不用买、不写进清单
	dish := models.Dish{Name: "番茄炒蛋", Ingredients: `["番茄","鸡蛋"]`, Seasonings: `[{"name":"盐","amount":"少许"},{"name":"清水","amount":"200毫升"}]`}
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

func TestApplyRecordUpdateOnlyTouchesSentFields(t *testing.T) {
	record := models.MealRecord{Rating: 4, Remark: "好吃", Mood: "yum", Photo: "/uploads/a.jpg"}
	var req UpdateRecordRequest
	// 历史页过去只提交心情/备注/照片：没带 rating 时不能把评分清成 0
	if err := json.Unmarshal([]byte(`{"mood":"ok"}`), &req); err != nil {
		t.Fatal(err)
	}
	applyRecordUpdate(&record, req)
	if record.Rating != 4 || record.Remark != "好吃" || record.Photo != "/uploads/a.jpg" || record.Mood != "ok" {
		t.Fatalf("只应改心情, got %+v", record)
	}
	// 显式传 0 / 空串表示清空
	if err := json.Unmarshal([]byte(`{"rating":0,"remark":"","photo":""}`), &req); err != nil {
		t.Fatal(err)
	}
	applyRecordUpdate(&record, req)
	if record.Rating != 0 || record.Remark != "" || record.Photo != "" || record.Mood != "ok" {
		t.Fatalf("显式传的零值应写入, got %+v", record)
	}
}

func TestRecordRatingValidation(t *testing.T) {
	setupHandlerTestDB(t, &models.Dish{}, &models.MealRecord{}, &models.ShoppingCheck{})
	record := models.MealRecord{DishID: 1, DishName: "番茄炒蛋", MealType: "lunch", MealDate: "2026-10-28", Rating: 3}
	database.DB.Create(&record)

	w := serveJSON(t, UpdateRecord, "PUT", "/api/records/1", map[string]any{"rating": 9}, gin.Param{Key: "id", Value: fmt.Sprint(record.ID)})
	if w.Code != 400 {
		t.Fatalf("评分超出 0-5 应返回 400, got %d %s", w.Code, w.Body.String())
	}
	var stored models.MealRecord
	database.DB.First(&stored, record.ID)
	if stored.Rating != 3 {
		t.Fatalf("被拒绝的更新不应写库, rating=%d", stored.Rating)
	}

	w = serveJSON(t, CreateRecord, "POST", "/api/records", map[string]any{
		"dish_id": 1, "dish_name": "番茄炒蛋", "meal_type": "dinner", "meal_date": "2026-10-28", "rating": -1,
	})
	if w.Code != 400 {
		t.Fatalf("新建记录评分超出 0-5 应返回 400, got %d %s", w.Code, w.Body.String())
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
