package services

import (
	"ninimenu/internal/models"
	"testing"
)

func TestDishMatchesDislike(t *testing.T) {
	spicyDish := dishWithIngredients(1, "麻辣火锅", false, `[{"name":"牛肉","amount":"500g"}]`)
	spicyDish.Taste = "麻辣"
	cilantroDish := dishWithIngredients(2, "香菜拌牛肉", false, `[{"name":"香菜","amount":"1把"},{"name":"牛肉","amount":"200g"}]`)
	porkByAlias := dishWithIngredients(3, "青椒肉丝", false, `[{"name":"瘦肉","amount":"200g"},{"name":"青椒","amount":"2个"}]`)
	seafoodDish := dishWithIngredients(4, "白灼虾", false, `[{"name":"虾仁","amount":"300g"}]`)
	offalDish := dishWithIngredients(5, "卤猪肝", false, `[{"name":"猪肝","amount":"300g"}]`)
	plainDish := dishWithIngredients(6, "清炒土豆丝", false, `[{"name":"马铃薯","amount":"1个"}]`)

	tests := []struct {
		dish    models.Dish
		dislike string
		want    bool
		note    string
	}{
		{spicyDish, "辣", true, "口味含辣"},
		{spicyDish, "牛肉", true, "食材命中"},
		{cilantroDish, "香菜", true, "香菜命中"},
		{porkByAlias, "猪肉", true, "瘦肉经别名命中猪肉"},
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

	// 无忌口：收藏菜权重 3
	idx := buildWeightedIndices(dishes, nil)
	if len(idx) != 4 {
		t.Fatalf("no dislikes: total weight = %d, want 4 (3+1)", len(idx))
	}
	// 忌口牛肉：收藏菜降回权重 1
	idx = buildWeightedIndices(dishes, map[string]bool{"牛肉": true})
	if len(idx) != 2 {
		t.Fatalf("with dislike: total weight = %d, want 2 (1+1)", len(idx))
	}
}
