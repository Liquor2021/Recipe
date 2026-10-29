package handlers

import (
	"encoding/json"
	"fmt"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
	"time"

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

func TestStatsAndDishRecordsIgnorePlannedMeals(t *testing.T) {
	setupHandlerTestDB(t, &models.Dish{}, &models.MealRecord{}, &models.DayRating{})
	dish := models.Dish{Name: "番茄炒蛋", Enabled: true}
	database.DB.Create(&dish)
	day := func(n int) string { return time.Now().AddDate(0, 0, n).Format("2006-01-02") }
	for _, r := range []models.MealRecord{
		{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: day(-3), Rating: 4},
		{DishID: dish.ID, DishName: dish.Name, MealType: "dinner", MealDate: day(0)},
		{DishID: dish.ID, DishName: dish.Name, MealType: "lunch", MealDate: day(1), Rating: 1}, // 明日菜单：计划
	} {
		database.DB.Create(&r)
	}

	w := serveJSON(t, GetStats, "GET", "/api/stats", nil)
	var stats struct {
		Data struct {
			TotalRecords int64 `json:"total_records"`
			LunchCount   int64 `json:"lunch_count"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil || stats.Data.TotalRecords != 2 || stats.Data.LunchCount != 1 {
		t.Fatalf("累计做饭只算吃过的（2 次，午餐 1 次）, got %s", w.Body.String())
	}

	w = serveJSON(t, GetDishRecords, "GET", fmt.Sprintf("/api/dishes/%d/records", dish.ID), nil, gin.Param{Key: "id", Value: fmt.Sprint(dish.ID)})
	var dr struct {
		Data struct {
			Records []struct {
				MealDate string `json:"meal_date"`
			} `json:"records"`
			Stats struct {
				TotalCount int     `json:"total_count"`
				LastDate   string  `json:"last_date"`
				AvgRating  float64 `json:"avg_rating"`
			} `json:"stats"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &dr); err != nil {
		t.Fatal(err)
	}
	if len(dr.Data.Records) != 3 {
		t.Fatalf("列表里保留计划记录, got %d", len(dr.Data.Records))
	}
	if dr.Data.Stats.TotalCount != 2 || dr.Data.Stats.LastDate != day(0) || dr.Data.Stats.AvgRating != 4 {
		t.Fatalf("做了几次/上次做/平均分只算吃过的, got %+v", dr.Data.Stats)
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
