package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"testing"

	"gorm.io/gorm"
)

func TestPhotoWallReadFailuresDoNotBecomeEmptySuccess(t *testing.T) {
	for _, table := range []string{"day_ratings", "meal_records"} {
		t.Run(table, func(t *testing.T) {
			setupHandlerTestDB(t, &models.DayRating{}, &models.MealRecord{})
			date := services.TodayDate()
			if err := database.DB.Create(&models.DayRating{MealDate: date, Photos: `["/uploads/tomato.jpg"]`}).Error; err != nil {
				t.Fatal(err)
			}
			if err := database.DB.Create(&models.MealRecord{DishID: 1, DishName: "番茄炒蛋", MealDate: date, MealType: "dinner", Status: models.MealCompleted}).Error; err != nil {
				t.Fatal(err)
			}
			if err := database.DB.Callback().Query().Before("gorm:query").Register("test:photo_wall_read_error", func(tx *gorm.DB) {
				// 只让真正的结果查询失败，跳过日期子查询的 SQL 构建阶段。
				_, readingRecords := tx.Statement.Dest.(*[]models.MealRecord)
				if tx.Statement.Table == table && (table != "meal_records" || readingRecords) {
					tx.AddError(errors.New("injected read failure"))
				}
			}); err != nil {
				t.Fatal(err)
			}
			w := serveJSON(t, GetPhotoWall, http.MethodGet, "/api/photo-wall", nil)
			if w.Code != http.StatusInternalServerError {
				t.Fatalf("read failure became success: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestPhotoWallEmptyAndSavedPhotosRemainSuccessful(t *testing.T) {
	setupHandlerTestDB(t, &models.DayRating{}, &models.MealRecord{})
	read := func() (int, []PhotoWallDay) {
		t.Helper()
		w := serveJSON(t, GetPhotoWall, http.MethodGet, "/api/photo-wall", nil)
		var response struct {
			Data struct {
				Days        []PhotoWallDay `json:"days"`
				TotalPhotos int            `json:"total_photos"`
			} `json:"data"`
		}
		if w.Code != http.StatusOK {
			t.Fatalf("expected success, got %d %s", w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response.Data.TotalPhotos, response.Data.Days
	}
	if count, days := read(); count != 0 || days == nil || len(days) != 0 {
		t.Fatalf("empty wall should return an empty array: %d %#v", count, days)
	}
	date := services.TodayDate()
	if err := database.DB.Create(&models.DayRating{MealDate: date, Photos: `["/uploads/tomato.jpg"]`, Remark: "今天吃得开心"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := database.DB.Create(&models.MealRecord{DishID: 1, DishName: "番茄炒蛋", MealDate: date, MealType: "dinner", Status: models.MealCompleted}).Error; err != nil {
		t.Fatal(err)
	}
	if count, days := read(); count != 1 || len(days) != 1 || len(days[0].Records) != 1 || days[0].DayRemark != "今天吃得开心" {
		t.Fatalf("saved wall content missing: %d %+v", count, days)
	}
}
