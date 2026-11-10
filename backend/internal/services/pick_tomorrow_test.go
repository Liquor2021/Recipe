package services

import (
	"math/rand"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"reflect"
	"testing"
)

func TestTomorrowSortKeepsRandomTiesAndPreferenceScores(t *testing.T) {
	base := make([]models.Dish, 12)
	for i := range base {
		base[i] = models.Dish{ID: uint(i + 1), Difficulty: "easy", CookTime: 15}
	}
	base[0].Favorite = true
	a, b := append([]models.Dish(nil), base...), append([]models.Dish(nil), base...)
	sortTomorrowPool(a, "balanced", nil, nil, rand.New(rand.NewSource(1)))
	sortTomorrowPool(b, "balanced", nil, nil, rand.New(rand.NewSource(2)))
	if a[0].ID != 1 || b[0].ID != 1 {
		t.Fatal("收藏加分仍应生效")
	}
	if reflect.DeepEqual(a, b) {
		t.Fatal("不同随机种子的同分菜不应被 ID 排回同一顺序")
	}
}

func TestTomorrowSortAvoidsRecentChoicesWithoutPromotingDislikes(t *testing.T) {
	dishes := []models.Dish{
		{ID: 1, Favorite: true, Difficulty: "easy"},
		{ID: 2, Difficulty: "hard"},
		{ID: 3, Taste: "辣", Favorite: true},
	}
	sortTomorrowPool(dishes, "balanced", map[string]bool{"辣": true}, map[uint]bool{1: true}, rand.New(rand.NewSource(1)))
	got := []uint{dishes[0].ID, dishes[1].ID, dishes[2].ID}
	if !reflect.DeepEqual(got, []uint{2, 1, 3}) {
		t.Fatalf("应优先没看过的合适菜，温和忌口仍排最后，got %v", got)
	}
}

func TestTomorrowPickExclusionsSurviveEveryFallback(t *testing.T) {
	for _, tc := range []struct {
		name    string
		profile string
		exclude []uint
		avoid   []uint
		recent  bool
		want    []uint
	}{
		{"排除当前菜后无候选，不能放回原菜", "balanced", []uint{1, 3}, nil, false, nil},
		{"偏好池为空时只放宽偏好", "light", []uint{1}, nil, false, []uint{3}},
		{"最近都吃过时仍不放回当前菜", "light", []uint{1}, nil, true, []uint{3}},
		{"历史软排除不会耗尽候选", "balanced", []uint{1}, []uint{3}, false, []uint{3}},
		{"偏好内优先没看过的菜", "balanced", nil, []uint{1}, false, []uint{3, 1}},
		{"收藏偏好不被浏览历史放宽", "favorite", nil, []uint{1}, false, []uint{1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setupTestDB(t, &models.Dish{}, &models.MealRecord{})
			seedSetting(t, "repeat_days", "7")
			seedSetting(t, "family_members", `[{"name":"家人","dislikes":["辣"]}]`)
			seedSetting(t, "family_dislike_mode", "strict")
			dishes := []models.Dish{
				{ID: 1, Name: "清淡收藏", MealType: "all", Taste: "清淡", Favorite: true},
				{ID: 2, Name: "忌口菜", MealType: "lunch", Taste: "辣"},
				{ID: 3, Name: "慢炖菜", MealType: "all", Difficulty: "hard", CookTime: 60},
				{ID: 4, Name: "已停用", MealType: "lunch"},
				{ID: 5, Name: "只供晚餐", MealType: "dinner"},
			}
			if err := database.DB.Create(&dishes).Error; err != nil {
				t.Fatal(err)
			}
			if err := database.DB.Model(&models.Dish{}).Where("id = ?", 4).Update("enabled", false).Error; err != nil {
				t.Fatal(err)
			}
			if tc.recent {
				err := database.DB.Create(&models.MealRecord{DishID: 3, DishName: "慢炖菜", MealType: "lunch", MealDate: TodayDate(), Status: models.MealCompleted}).Error
				if err != nil {
					t.Fatal(err)
				}
			}
			picks, err := PickTomorrowDishes(TomorrowPickOptions{MealType: "lunch", Profile: tc.profile, Count: 2, ExcludeIDs: tc.exclude, AvoidIDs: tc.avoid})
			if err != nil {
				t.Fatal(err)
			}
			var got []uint
			for _, dish := range picks {
				got = append(got, dish.ID)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}
