package handlers

import (
	"encoding/json"
	"errors"
	"ninimenu/internal/models"
	"sync"
	"testing"

	"gorm.io/gorm"
)

func readTestDayRating(t *testing.T, date string) DayRatingSnapshot {
	t.Helper()
	w := serveJSON(t, GetDayRating, "GET", "/api/day-rating?date="+date, nil)
	var response struct {
		Data DayRatingSnapshot `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 || len(response.Data.Version) != 64 {
		t.Fatalf("read snapshot failed: %d %s %v", w.Code, w.Body.String(), err)
	}
	return response.Data
}

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
			tc.body["expected_version"] = readTestDayRating(t, rating.MealDate).Version
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
		w := serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "expected_version": readTestDayRating(t, date).Version, "mood": "yum", "remark": "保留备注", "photos": `["/uploads/a.jpg"]`})
		if w.Code != 200 {
			t.Fatalf("保存评价失败: %s", w.Body.String())
		}
		postHome("tired")
		w = serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "expected_version": readTestDayRating(t, date).Version, "photos": ""})
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

func TestDayRatingReadFailureIsNotEmptySuccess(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	if err := db.Create(&models.DayRating{MealDate: "2026-11-08", Mood: "great", Remark: "保留备注", Photos: `["/uploads/a.jpg"]`}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().Before("gorm:query").Register("test:rating_read_failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "day_ratings" {
			tx.AddError(errors.New("private database failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		path string
		list bool
	}{
		{"/api/day-rating?date=2026-11-08", false},
		{"/api/day-ratings?date_from=2026-11-01&date_to=2026-11-30", true},
	} {
		handler := GetDayRating
		if tc.list {
			handler = GetDayRatings
		}
		w := serveJSON(t, handler, "GET", tc.path, nil)
		if w.Code != 500 {
			t.Fatalf("read error became success: %d %s", w.Code, w.Body.String())
		}
		var response struct {
			Data    any    `json:"data"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || response.Data != nil || response.Message == "private database failure" {
			t.Fatalf("invalid error response: %s", w.Body.String())
		}
	}
	db.Callback().Query().Remove("test:rating_read_failure")
	if got := readTestDayRating(t, "2026-11-08"); got.Remark != "保留备注" || got.Photos != `["/uploads/a.jpg"]` {
		t.Fatalf("read failure changed saved content: %+v", got)
	}
}

func TestDayRatingVersionRejectsStalePhotoAndEvaluationWrites(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	const date = "2026-11-08"
	original := models.DayRating{MealDate: date, Mood: "great", Remark: "保留备注", Photos: `["/uploads/a.jpg","/uploads/b.jpg"]`}
	if err := db.Create(&original).Error; err != nil {
		t.Fatal(err)
	}
	stale := readTestDayRating(t, date)
	w := serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "expected_version": stale.Version, "photos": `["/uploads/a.jpg","/uploads/b.jpg","/uploads/c.jpg"]`})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	current := readTestDayRating(t, date)
	if stale.Version == current.Version {
		t.Fatal("content update must change version")
	}
	for _, body := range []map[string]any{
		{"meal_date": date, "expected_version": stale.Version, "photos": `["/uploads/b.jpg"]`},
		{"meal_date": date, "expected_version": stale.Version, "mood": "ok", "remark": "旧草稿", "photos": stale.Photos},
		{"meal_date": date, "photos": "[]"},
	} {
		w = serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", body)
		if w.Code != 409 {
			t.Fatalf("stale or missing baseline must fail: %d %s", w.Code, w.Body.String())
		}
		if got := readTestDayRating(t, date); got.Version != current.Version {
			t.Fatalf("conflict wrote data: %+v", got)
		}
	}
	w = serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "expected_version": current.Version, "photos": `["/uploads/b.jpg","/uploads/c.jpg"]`})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if got := readTestDayRating(t, date); got.Photos != `["/uploads/b.jpg","/uploads/c.jpg"]` || got.Remark != "保留备注" {
		t.Fatalf("confirmed deletion must preserve newer photo and remark: %+v", got)
	}
}

func TestDayRatingHomeMoodDoesNotInvalidateContentVersion(t *testing.T) {
	setupRecordLifecycleDB(t)
	const date = "2026-11-08"
	empty := readTestDayRating(t, date)
	if empty.ID != 0 || empty.Photos != "[]" || empty.MealDate != date {
		t.Fatalf("empty editable snapshot: %+v", empty)
	}
	for _, mood := range []string{"happy", "tired"} {
		w := serveJSON(t, CreateOrUpdateHomeMood, "POST", "/api/day-rating/home-mood", map[string]any{"meal_date": date, "home_mood": mood})
		var response struct {
			Data DayRatingSnapshot `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 || response.Data.Version != empty.Version {
			t.Fatalf("home mood must preserve editable version: %s", w.Body.String())
		}
	}
	w := serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "expected_version": empty.Version, "mood": "great", "remark": "新的评价", "photos": `["/uploads/a.jpg"]`})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	got := readTestDayRating(t, date)
	if got.HomeMood != "tired" || got.Version == empty.Version {
		t.Fatalf("content must preserve home mood: %+v", got)
	}
	w = serveJSON(t, GetDayRatings, "GET", "/api/day-ratings?date_from=2026-11-01&date_to=2026-11-30", nil)
	var list struct {
		Data []DayRatingSnapshot `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list.Data) != 1 || list.Data[0].Version != got.Version {
		t.Fatalf("list must return matching version: %s", w.Body.String())
	}
}

func TestDayRatingConcurrentEditsOnlyOneBaselineWins(t *testing.T) {
	setupRecordLifecycleDB(t)
	const date = "2026-11-08"
	baseline := readTestDayRating(t, date).Version
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for _, text := range []string{"端A的评价", "端B的评价"} {
		wg.Add(1)
		go func(remark string) {
			defer wg.Done()
			w := serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "expected_version": baseline, "remark": remark})
			results <- w.Code
		}(text)
	}
	wg.Wait()
	close(results)
	counts := map[int]int{}
	for code := range results {
		counts[code]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatalf("one success and one conflict required: %v", counts)
	}
}

func TestDayRatingSaveReadbackFailureRollsBack(t *testing.T) {
	db := setupRecordLifecycleDB(t)
	const date = "2026-11-08"
	if err := db.Create(&models.DayRating{MealDate: date, Mood: "great", Remark: "原备注", Photos: `["/uploads/a.jpg"]`}).Error; err != nil {
		t.Fatal(err)
	}
	original := readTestDayRating(t, date)
	reads := 0
	db.Callback().Query().Before("gorm:query").Register("test:rating_readback_failure", func(tx *gorm.DB) {
		if tx.Statement.Table == "day_ratings" {
			reads++
			if reads == 2 {
				tx.AddError(errors.New("readback failed"))
			}
		}
	})
	w := serveJSON(t, CreateOrUpdateDayRating, "POST", "/api/day-rating", map[string]any{"meal_date": date, "expected_version": original.Version, "photos": "[]", "remark": "新的备注"})
	db.Callback().Query().Remove("test:rating_readback_failure")
	if w.Code != 500 {
		t.Fatalf("failure must not report success: %d %s", w.Code, w.Body.String())
	}
	if got := readTestDayRating(t, date); got.Version != original.Version {
		t.Fatalf("failed transaction was not rolled back: %+v", got)
	}
}
