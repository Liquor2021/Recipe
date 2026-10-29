package services

import (
	"math/rand"
	"ninimenu/internal/models"
	"testing"
)

func TestDishMatchesDislike(t *testing.T) {
	spicyDish := dishWithIngredients(1, "麻辣火锅", false, `[{"name":"牛肉","amount":"500g"}]`)
	spicyDish.Taste = "麻辣"
	spicyByName := dishWithIngredients(2, "辣子鸡丁", false, `[{"name":"鸡腿","amount":"300g"}]`)
	spicyByName.Taste = "咸鲜"
	cilantroDish := dishWithIngredients(3, "香菜拌牛肉", false, `[{"name":"香菜","amount":"1把"},{"name":"牛肉","amount":"200g"}]`)
	porkByCategory := dishWithIngredients(4, "青椒肉丝", false, `[{"name":"瘦肉","amount":"200g"},{"name":"青椒","amount":"2个"}]`)
	seafoodDish := dishWithIngredients(5, "白灼虾", false, `[{"name":"虾仁","amount":"300g"}]`)
	offalDish := dishWithIngredients(6, "卤猪肝", false, `[{"name":"猪肝","amount":"300g"}]`)
	plainDish := dishWithIngredients(7, "清炒土豆丝", false, `[{"name":"马铃薯","amount":"1个"}]`)

	tests := []struct {
		dish    models.Dish
		dislike string
		want    bool
		note    string
	}{
		{spicyDish, "辣", true, "口味含辣"},
		{spicyByName, "辣", true, "菜名含辣（Taste 没写辣也不漏判）"},
		{spicyDish, "牛肉", true, "食材命中"},
		{cilantroDish, "香菜", true, "香菜命中"},
		{porkByCategory, "猪肉", true, "瘦肉经大类命中猪肉"},
		{porkByCategory, "五花肉", true, "不吃五花肉也应命中写瘦肉的菜（同大类）"},
		{seafoodDish, "海鲜", true, "虾仁算海鲜"},
		{offalDish, "内脏", true, "猪肝算内脏"},
		{plainDish, "辣", false, "清淡菜不命中辣"},
		{plainDish, "海鲜", false, "土豆不是海鲜"},
		{plainDish, "猪肉", false, "土豆不命中猪肉"},
	}
	for _, tt := range tests {
		if got := dishMatchesDislike(tt.dish, tt.dislike); got != tt.want {
			t.Fatalf("dishMatchesDislike(%s, %q) = %v, want %v (%s)", tt.dish.Name, tt.dislike, got, tt.want, tt.note)
		}
	}
}

func TestDishHitsDislikes(t *testing.T) {
	dish := dishWithIngredients(1, "麻辣香锅", false, `[{"name":"虾仁","amount":"200g"}]`)
	dish.Taste = "香辣"
	if !dishHitsDislikes(dish, map[string]bool{"香菜": true, "海鲜": true}) {
		t.Fatal("命中任一忌口应返回 true")
	}
	if dishHitsDislikes(dish, map[string]bool{}) {
		t.Fatal("空忌口集不应命中")
	}
	if dishHitsDislikes(dish, nil) {
		t.Fatal("nil 忌口集不应命中")
	}
}

func TestBuildWeightedIndicesDislikePenalty(t *testing.T) {
	favDish := dishWithIngredients(1, "麻辣牛肉", true, `[{"name":"牛肉","amount":"300g"}]`)
	favDish.Taste = "麻辣"
	normalDish := dishWithIngredients(2, "清炒时蔬", false, `[{"name":"青菜","amount":"300g"}]`)
	dishes := []models.Dish{favDish, normalDish}

	// 无忌口：收藏 9 + 普通 3（收藏 : 普通 = 3 : 1）
	idx := buildWeightedIndices(dishes, nil)
	if len(idx) != 12 {
		t.Fatalf("no dislikes: total weight = %d, want 12 (9+3)", len(idx))
	}
	// 忌口牛肉：命中忌口优先于收藏，降到 1，是普通菜的 1/3
	idx = buildWeightedIndices(dishes, map[string]bool{"牛肉": true})
	if len(idx) != 4 {
		t.Fatalf("with dislike: total weight = %d, want 4 (1+3)", len(idx))
	}
	// 忌口青菜：普通菜也降到 1（过去非收藏菜命中忌口完全不降权）
	idx = buildWeightedIndices(dishes, map[string]bool{"青菜": true})
	if len(idx) != 10 {
		t.Fatalf("plain dish dislike: total weight = %d, want 10 (9+1)", len(idx))
	}
}

func TestWeightedPickDistribution(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	dishes := []models.Dish{{ID: 1}, {ID: 2}}
	weight := func(d models.Dish) int {
		if d.ID == 1 {
			return dislikedDishWeight
		}
		return normalDishWeight
	}
	hits := 0
	const n = 8000
	for i := 0; i < n; i++ {
		if weightedPick(dishes, weight, r) == 0 {
			hits++
		}
	}
	// 权重 1 : 3，期望 25%
	if frac := float64(hits) / n; frac < 0.22 || frac > 0.28 {
		t.Fatalf("权重 1:3 时低权重项应约占 25%%, got %.3f", frac)
	}
}

func TestArrangeForRecommendation(t *testing.T) {
	spicyA := models.Dish{ID: 1, Name: "辣子鸡", Taste: "香辣"}
	plainB := models.Dish{ID: 2, Name: "清炒时蔬", Taste: "清淡"}
	spicyC := models.Dish{ID: 3, Name: "麻辣鸡丝", Taste: "麻辣"}
	plainD := models.Dish{ID: 4, Name: "蒸蛋", Taste: "清淡"}
	dishes := []models.Dish{spicyA, plainB, spicyC, plainD}
	tokens := map[string]bool{"辣": true}
	r := rand.New(rand.NewSource(7))

	got := arrangeForRecommendation(dishes, familyDislikeConfig{tokens: tokens}, false, r)
	if names := namesOf(got); len(got) != 4 || got[0].ID != 2 || got[1].ID != 4 || got[2].ID != 1 || got[3].ID != 3 {
		t.Fatalf("avoid 应保留全部并把忌口菜稳定地排到最后, got %v", names)
	}
	if got := arrangeForRecommendation(dishes, familyDislikeConfig{tokens: tokens, strict: true}, false, r); len(got) != 2 || got[0].ID != 2 || got[1].ID != 4 {
		t.Fatalf("strict 应剔除忌口菜, got %v", namesOf(got))
	}
	for i := 0; i < 20; i++ {
		got := arrangeForRecommendation(dishes, familyDislikeConfig{tokens: tokens}, true, r)
		if dishHitsDislikes(got[0], tokens) || dishHitsDislikes(got[1], tokens) {
			t.Fatalf("avoid 随机排列也应合规菜在前, got %v", namesOf(got))
		}
	}
	if dishes[0].ID != 1 {
		t.Fatalf("不应修改原切片")
	}
	if got := arrangeForRecommendation(dishes, familyDislikeConfig{}, false, r); got[0].ID != 1 {
		t.Fatalf("未配置忌口时保持原顺序, got %v", namesOf(got))
	}
}
