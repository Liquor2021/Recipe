package handlers

import (
	"encoding/json"
	"ninimenu/internal/models"
	"testing"
)

func TestDayRatingPartialUpdatesPreserveOtherFields(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	rating := models.DayRating{MealDate: "2026-11-07", HomeMood: "happy", Mood: "yum", Remark: "今天做得很好", Photos: `["/uploads/a.jpg","/uploads/b.jpg"]`}
	if err := db.Create(&rating).Error; err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name                             string
		body                             map[string]any
		wantMood, wantRemark, wantPhotos string
	}{
		{"删除一张照片", map[string]any{"photos": `["/uploads/b.jpg"]`}, "yum", "今天做得很好", `["/uploads/b.jpg"]`},
		{"仅改备注", map[string]any{"remark": "下次少放盐"}, "yum", "下次少放盐", `["/uploads/b.jpg"]`},
		{"仅改心情", map[string]any{"mood": "ok"}, "ok", "下次少放盐", `["/uploads/b.jpg"]`},
		{"不提交字段", map[string]any{}, "ok", "下次少放盐", `["/uploads/b.jpg"]`},
		{"明确清空备注", map[string]any{"remark": ""}, "ok", "", `["/uploads/b.jpg"]`},
		{"删除最后一张照片", map[string]any{"photos": "[]"}, "ok", "", "[]"},
		{"明确清空心情", map[string]any{"mood": ""}, "", "", "[]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tc.body["meal_date"] = rating.MealDate
			w := serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", tc.body)
			if w.Code != 200 {
				t.Fatalf("更新失败: %d %s", w.Code, w.Body.String())
			}
			var stored models.DayRating
			if err := db.First(&stored, rating.ID).Error; err != nil {
				t.Fatal(err)
			}
			if stored.HomeMood != "happy" || stored.Mood != tc.wantMood || stored.Remark != tc.wantRemark || stored.Photos != tc.wantPhotos {
				t.Fatalf("部分更新误改了其他字段: %+v", stored)
			}
			var resp struct {
				Data models.DayRating `json:"data"`
			}
			err := json.Unmarshal(w.Body.Bytes(), &resp)
			got := resp.Data
			sameTimes := got.CreatedAt.Equal(stored.CreatedAt) && got.UpdatedAt.Equal(stored.UpdatedAt)
			got.CreatedAt, got.UpdatedAt = stored.CreatedAt, stored.UpdatedAt
			if err != nil || !sameTimes || got != stored {
				t.Fatalf("响应应返回完整保存结果: %s (err=%v)", w.Body.String(), err)
			}
		})
	}
}

func TestDayRatingAndHomeMoodUpsertKeepEachOthersFields(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	for _, homeFirst := range []bool{false, true} {
		date := "2026-11-06"
		if homeFirst {
			date = "2026-11-07"
		}
		postHome := func(mood string) {
			w := serveJSON(t, CreateOrUpdateHomeMood, "POST", "/api/day-rating/home-mood", map[string]any{"meal_date": date, "home_mood": mood})
			if w.Code != 200 {
				t.Fatalf("首页心情失败: %s", w.Body.String())
			}
		}
		if homeFirst {
			postHome("happy")
		}
		w := serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "mood": "yum", "remark": "保留备注", "photos": `["/uploads/a.jpg"]`})
		if w.Code != 200 {
			t.Fatalf("保存评价失败: %s", w.Body.String())
		}
		postHome("tired")
		w = serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "photos": ""})
		if w.Code != 200 {
			t.Fatalf("清空照片失败: %s", w.Body.String())
		}
		var stored models.DayRating
		if err := db.Where("meal_date = ?", date).First(&stored).Error; err != nil {
			t.Fatal(err)
		}
		if stored.HomeMood != "tired" || stored.Mood != "yum" || stored.Remark != "保留备注" || stored.Photos != "[]" {
			t.Fatalf("各入口应仅写入自身字段: %+v", stored)
		}
		var count int64
		db.Model(&models.DayRating{}).Where("meal_date = ?", date).Count(&count)
		if count != 1 {
			t.Fatalf("同一天必须只有一条评价, got %d", count)
		}
	}
}
