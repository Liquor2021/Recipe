package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"

	"gorm.io/gorm"
)

func TestReportReadFailuresDoNotReturnPartialData(t *testing.T) {
	stages := []struct {
		name  string
		row   bool
		match func(*gorm.Statement) bool
	}{
		{"meal records", false, func(s *gorm.Statement) bool {
			_, ok := s.Dest.(*[]models.MealRecord)
			return ok
		}},
		{"dishes", false, func(s *gorm.Statement) bool {
			_, ok := s.Dest.(*[]models.Dish)
			return ok
		}},
		{"first cooked dates", true, func(s *gorm.Statement) bool {
			_, grouped := s.Clauses["GROUP BY"]
			return s.Table == "meal_records" && grouped
		}},
		{"previous cook days", false, func(s *gorm.Statement) bool {
			_, ok := s.Dest.(*int64)
			return s.Table == "meal_records" && ok
		}},
		{"day ratings", false, func(s *gorm.Statement) bool {
			_, ok := s.Dest.(*[]models.DayRating)
			return ok
		}},
		{"ingredient categories", false, func(s *gorm.Statement) bool {
			_, ok := s.Dest.(*[]models.ShoppingItemCategory)
			return ok
		}},
	}
	for _, stage := range stages {
		t.Run(stage.name, func(t *testing.T) {
			db := setupHandlerTestDB(t, &models.Dish{}, &models.MealRecord{}, &models.DayRating{}, &models.ShoppingItemCategory{})
			date := services.TodayDate()
			for _, row := range []any{
				&models.Dish{ID: 1, Name: "自种叶菜", Ingredients: `[{"name":"自种叶菜","amount":"1把"}]`},
				&models.MealRecord{DishID: 1, DishName: "自种叶菜", MealDate: date, MealType: "lunch", Status: models.MealCompleted},
				&models.DayRating{MealDate: date, Mood: "yum"},
				&models.ShoppingItemCategory{ItemName: "自种叶菜", Category: "蔬菜"},
			} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			injected := errors.New("private database error detail")
			failReads, hit := true, false
			callback := func(tx *gorm.DB) {
				if failReads && stage.match(tx.Statement) {
					hit = true
					tx.AddError(injected)
				}
			}
			var err error
			if stage.row {
				err = db.Callback().Row().Before("gorm:row").Register("test:report_read_error", callback)
			} else {
				err = db.Callback().Query().Before("gorm:query").Register("test:report_read_error", callback)
			}
			if err != nil {
				t.Fatal(err)
			}
			report, err := services.GetDietReport("week")
			if !hit || !errors.Is(err, injected) || report != nil {
				t.Fatalf("failed read must return its error without a partial report: hit=%v, report=%+v, err=%v", hit, report, err)
			}
			w := serveJSON(t, GetReport, http.MethodGet, "/api/report?range=week", nil)
			var response struct {
				Code    int             `json:"code"`
				Message string          `json:"message"`
				Data    json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if w.Code != http.StatusInternalServerError || response.Code != 50000 || response.Message != "读取饮食报告失败" || string(response.Data) != "null" {
				t.Fatalf("read failure must produce a generic error without report data: %d %s", w.Code, w.Body.String())
			}

			// 一次失败不能污染后续重试，人工食材分类也应继续参与统计。
			failReads = false
			report, err = services.GetDietReport("week")
			if err != nil || report == nil {
				t.Fatalf("retry failed: report=%+v, err=%v", report, err)
			}
			if report.TotalMeals != 1 || report.Balance.MealsWithVeg != 1 || len(report.MoodShares) != 1 {
				t.Fatalf("retry lost report data: %+v", report)
			}
		})
	}
}

func TestReportEmptyDataStillReturnsSuccess(t *testing.T) {
	setupHandlerTestDB(t, &models.Dish{}, &models.MealRecord{}, &models.DayRating{}, &models.ShoppingItemCategory{})
	for _, period := range []string{"week", "month"} {
		w := serveJSON(t, GetReport, http.MethodGet, "/api/report?range="+period, nil)
		var response struct {
			Code int                  `json:"code"`
			Data *services.DietReport `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		report := response.Data
		if w.Code != http.StatusOK || response.Code != 0 || report == nil {
			t.Fatalf("empty data must remain a successful report: %d %s", w.Code, w.Body.String())
		}
		if report.Range != period || report.TotalMeals != 0 || report.CookDays != 0 || report.PrevCookDays != 0 || report.TopDishes == nil || report.MoodShares == nil || report.Balance.Vegetables == nil {
			t.Fatalf("empty report changed: %+v", report)
		}
	}
}
