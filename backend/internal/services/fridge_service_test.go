package services

import (
	"fmt"
	"ninimenu/internal/models"
	"testing"
)

func dishWithIngredients(id uint, name string, favorite bool, ingredients string) models.Dish {
	return models.Dish{ID: id, Name: name, Favorite: favorite, Ingredients: ingredients}
}

func matchNames(matches []FridgeMatch) []string {
	names := make([]string, len(matches))
	for i, m := range matches {
		names[i] = fmt.Sprintf("%s(%d%%)", m.Dish.Name, m.Coverage)
	}
	return names
}

func TestMatchDishesWithInventoryRanking(t *testing.T) {
	dishes := []models.Dish{
		dishWithIngredients(1, "番茄炒蛋", false, `[{"name":"番茄","amount":"2个"},{"name":"鸡蛋","amount":"3个"}]`),
		dishWithIngredients(2, "番茄牛腩", false, `[{"name":"西红柿","amount":"2个"},{"name":"牛腩","amount":"500g"},{"name":"土豆","amount":"1个"}]`),
		dishWithIngredients(3, "红烧排骨", false, `[{"name":"排骨","amount":"500g"}]`),
		dishWithIngredients(4, "凉拌黄瓜", false, `[]`),
	}
	stock := []string{"番茄", "鸡蛋", "土豆"}

	matches := matchDishesWithInventory(dishes, stock, 12)

	got := matchNames(matches)
	want := []string{"番茄炒蛋(100%)", "番茄牛腩(66%)", "红烧排骨(0%)"}
	// 红烧排骨 0 命中应被排除
	want = want[:2]
	if len(got) != len(want) {
		t.Fatalf("matches = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("matches[%d] = %q, want %q; full: %v", i, got[i], want[i], got)
		}
	}
}

func TestMatchDishesWithInventoryAlias(t *testing.T) {
	dishes := []models.Dish{
		dishWithIngredients(1, "番茄牛腩", false, `[{"name":"西红柿","amount":"2个"},{"name":"牛腩","amount":"500g"}]`),
		dishWithIngredients(2, "酸辣土豆丝", false, `[{"name":"马铃薯","amount":"1个"}]`),
	}
	// 冰箱里记的是别名（番茄/土豆），菜谱里写的是另一个名字（西红柿/马铃薯）
	stock := []string{"番茄", "土豆"}

	matches := matchDishesWithInventory(dishes, stock, 12)
	if len(matches) != 2 {
		t.Fatalf("alias match failed, got %v", matchNames(matches))
	}
	// 命中率高的在前：土豆丝 100%，番茄牛腩 50%（西红柿经别名命中，牛腩缺）
	if matches[0].Dish.Name != "酸辣土豆丝" || matches[0].Coverage != 100 {
		t.Fatalf("matches[0] = %s %d%%, want 酸辣土豆丝 100%% (马铃薯 via 土豆 alias)", matches[0].Dish.Name, matches[0].Coverage)
	}
	if matches[1].Dish.Name != "番茄牛腩" || matches[1].Coverage != 50 {
		t.Fatalf("matches[1] = %s %d%%, want 番茄牛腩 50%% (西红柿 via 番茄 alias)", matches[1].Dish.Name, matches[1].Coverage)
	}
}

func TestMatchDishesWithInventoryOrdering(t *testing.T) {
	dishes := []models.Dish{
		dishWithIngredients(1, "菜A", false, `[{"name":"鸡蛋","amount":"1"},{"name":"番茄","amount":"1"},{"name":"牛肉","amount":"1"}]`),
		dishWithIngredients(2, "菜B", true, `[{"name":"鸡蛋","amount":"1"},{"name":"番茄","amount":"1"},{"name":"青菜","amount":"1"}]`),
		dishWithIngredients(3, "菜C", false, `[{"name":"鸡蛋","amount":"1"},{"name":"番茄","amount":"1"}]`),
	}
	stock := []string{"鸡蛋", "番茄"}

	matches := matchDishesWithInventory(dishes, stock, 12)
	if len(matches) != 3 {
		t.Fatalf("should match all 3, got %v", matchNames(matches))
	}
	// 菜C 100% 第一；菜A/菜B 都 66%，菜B 收藏加权排前
	want := []string{"菜C(100%)", "菜B(66%)", "菜A(66%)"}
	got := matchNames(matches)
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order[%d] = %q, want %q; full: %v", i, got[i], want[i], got)
		}
	}
}

func TestMatchDishesWithInventoryLimit(t *testing.T) {
	dishes := []models.Dish{
		dishWithIngredients(1, "菜A", false, `[{"name":"鸡蛋","amount":"1"}]`),
		dishWithIngredients(2, "菜B", false, `[{"name":"鸡蛋","amount":"1"}]`),
		dishWithIngredients(3, "菜C", false, `[{"name":"鸡蛋","amount":"1"}]`),
	}
	matches := matchDishesWithInventory(dishes, []string{"鸡蛋"}, 2)
	if len(matches) != 2 {
		t.Fatalf("limit=2 should return 2, got %d", len(matches))
	}
}

func TestMatchDishesWithInventoryEmptyStock(t *testing.T) {
	dishes := []models.Dish{
		dishWithIngredients(1, "菜A", false, `[{"name":"鸡蛋","amount":"1"}]`),
	}
	if matches := matchDishesWithInventory(dishes, nil, 12); len(matches) != 0 {
		t.Fatalf("empty stock should match nothing, got %v", matchNames(matches))
	}
}

func TestMatchDishesNullJSONSafety(t *testing.T) {
	// 全命中时 missing 必须是空数组而非 null（前端 match.missing.length 会崩）
	dishes := []models.Dish{
		dishWithIngredients(1, "菜A", false, `[{"name":"鸡蛋","amount":"1"}]`),
	}
	matches := matchDishesWithInventory(dishes, []string{"鸡蛋"}, 12)
	if len(matches) != 1 {
		t.Fatalf("want 1 match, got %d", len(matches))
	}
	if matches[0].Missing == nil || matches[0].Matched == nil {
		t.Fatalf("Missing/Matched must be empty slices, not nil: matched=%v missing=%v", matches[0].Matched, matches[0].Missing)
	}
}

func TestMatchDishesStaplesExcluded(t *testing.T) {
	// 小葱是常备配料：不进分母，番茄+鸡蛋 2/2 = 100%
	dishes := []models.Dish{
		dishWithIngredients(1, "番茄炒蛋", false, `[{"name":"番茄","amount":"2个"},{"name":"鸡蛋","amount":"3个"},{"name":"小葱","amount":"1根"}]`),
		dishWithIngredients(2, "葱姜拌一切", false, `[{"name":"小葱","amount":"1把"},{"name":"姜","amount":"1块"}]`),
	}
	matches := matchDishesWithInventory(dishes, []string{"番茄", "鸡蛋"}, 12)
	if len(matches) != 1 {
		t.Fatalf("全常备配料的菜不应出现, got %v", matchNames(matches))
	}
	if matches[0].Dish.Name != "番茄炒蛋" || matches[0].Coverage != 100 {
		t.Fatalf("番茄炒蛋 = %s %d%%, want 番茄炒蛋 100%% (小葱应被忽略)", matches[0].Dish.Name, matches[0].Coverage)
	}
}

func TestNormalizeIngredientName(t *testing.T) {
	tests := []struct{ in, want string }{
		{" 番茄 ", "番茄"},
		{"西红柿", "番茄"},
		{"马铃薯", "土豆"},
		{"洋芋", "土豆"},
		{"Bacon", "bacon"},
		{"小白菜", "小白菜"}, // 别名表里"白菜"只映射自身/大白菜，小白菜不受影响
	}
	for _, tt := range tests {
		if got := normalizeIngredientName(tt.in); got != tt.want {
			t.Fatalf("normalizeIngredientName(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
