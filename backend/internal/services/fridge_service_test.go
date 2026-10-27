package services

import (
	"fmt"
	"ninimenu/internal/models"
	"testing"
	"time"
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
	stock := []StockItem{{Name: "番茄", DaysLeft: 999, BatchID: 201}, {Name: "鸡蛋", DaysLeft: 999, BatchID: 202}, {Name: "土豆", DaysLeft: 999, BatchID: 203}}

	matches := matchDishesWithInventory(dishes, stock, 12)

	got := matchNames(matches)
	want := []string{"番茄炒蛋(100%)", "番茄牛腩(66%)"}
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
	stock := []StockItem{{Name: "番茄", DaysLeft: 999, BatchID: 204}, {Name: "土豆", DaysLeft: 999, BatchID: 205}}

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
	stock := []StockItem{{Name: "鸡蛋", DaysLeft: 999, BatchID: 206}, {Name: "番茄", DaysLeft: 999, BatchID: 207}}

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

func TestMatchDishesUrgentPriority(t *testing.T) {
	// 同为 100% 命中，能用掉临期食材的菜排前面
	dishes := []models.Dish{
		dishWithIngredients(1, "青椒炒肉", false, `[{"name":"青椒","amount":"2个"},{"name":"猪肉","amount":"200g"}]`),
		dishWithIngredients(2, "番茄炒蛋", false, `[{"name":"番茄","amount":"2个"},{"name":"鸡蛋","amount":"3个"}]`),
	}
	stock := []StockItem{
		{Name: "番茄", DaysLeft: 1, BatchID: 208}, // 临期
		{Name: "鸡蛋", DaysLeft: 999, BatchID: 209},
		{Name: "青椒", DaysLeft: 999, BatchID: 210},
		{Name: "猪肉", DaysLeft: 999, BatchID: 211},
	}
	matches := matchDishesWithInventory(dishes, stock, 12)
	if len(matches) != 2 {
		t.Fatalf("want 2 matches, got %v", matchNames(matches))
	}
	if matches[0].Dish.Name != "番茄炒蛋" {
		t.Fatalf("urgent-using dish should rank first, got %v", matchNames(matches))
	}
	if len(matches[0].UsingUrgent) != 1 || matches[0].UsingUrgent[0] != "番茄" {
		t.Fatalf("UsingUrgent = %v, want [番茄]", matches[0].UsingUrgent)
	}
	if len(matches[1].UsingUrgent) != 0 {
		t.Fatalf("non-urgent dish should have empty UsingUrgent, got %v", matches[1].UsingUrgent)
	}
}

func TestMatchDishesWithInventoryLimit(t *testing.T) {
	dishes := []models.Dish{
		dishWithIngredients(1, "菜A", false, `[{"name":"鸡蛋","amount":"1"}]`),
		dishWithIngredients(2, "菜B", false, `[{"name":"鸡蛋","amount":"1"}]`),
		dishWithIngredients(3, "菜C", false, `[{"name":"鸡蛋","amount":"1"}]`),
	}
	matches := matchDishesWithInventory(dishes, []StockItem{{Name: "鸡蛋", DaysLeft: 999, BatchID: 212}}, 2)
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
	stock := []StockItem{{Name: "鸡蛋", DaysLeft: 999, BatchID: 213}}
	matches := matchDishesWithInventory(dishes, stock, 12)
	if len(matches) != 1 {
		t.Fatalf("want 1 match, got %d", len(matches))
	}
	if matches[0].Missing == nil || matches[0].Matched == nil || matches[0].UsingUrgent == nil || matches[0].MatchedBatchIDs == nil {
		t.Fatalf("slices must not be nil: matched=%v missing=%v urgent=%v batchIDs=%v", matches[0].Matched, matches[0].Missing, matches[0].UsingUrgent, matches[0].MatchedBatchIDs)
	}
	if len(matches[0].MatchedBatchIDs) != 1 || matches[0].MatchedBatchIDs[0] != stock[0].BatchID {
		t.Fatalf("MatchedBatchIDs = %v, want [201] (stock BatchID)", matches[0].MatchedBatchIDs)
	}
}

func TestMatchDishesStaplesExcluded(t *testing.T) {
	// 小葱是常备配料：不进分母，番茄+鸡蛋 2/2 = 100%
	dishes := []models.Dish{
		dishWithIngredients(1, "番茄炒蛋", false, `[{"name":"番茄","amount":"2个"},{"name":"鸡蛋","amount":"3个"},{"name":"小葱","amount":"1根"}]`),
		dishWithIngredients(2, "葱姜拌一切", false, `[{"name":"小葱","amount":"1把"},{"name":"姜","amount":"1块"}]`),
	}
	stock := []StockItem{{Name: "番茄", DaysLeft: 999, BatchID: 214}, {Name: "鸡蛋", DaysLeft: 999, BatchID: 215}}
	matches := matchDishesWithInventory(dishes, stock, 12)
	if len(matches) != 1 {
		t.Fatalf("全常备配料的菜不应出现, got %v", matchNames(matches))
	}
	if matches[0].Dish.Name != "番茄炒蛋" || matches[0].Coverage != 100 {
		t.Fatalf("番茄炒蛋 = %s %d%%, want 番茄炒蛋 100%% (小葱应被忽略)", matches[0].Dish.Name, matches[0].Coverage)
	}
}

func TestMatchDishesSlotDedup(t *testing.T) {
	// 真别名重复写（番茄+西红柿）与部位重复写（瘦肉+五花肉）都只算一个槽位，
	// 不虚增分母和命中数
	dishes := []models.Dish{
		// 菜A：番茄和西红柿是同一食材 → 槽位 [番茄,青椒]，冰箱有番茄 → 50%
		dishWithIngredients(1, "菜A", false, `[{"name":"番茄","amount":"1"},{"name":"西红柿","amount":"1"},{"name":"青椒","amount":"1"}]`),
		// 菜B：瘦肉和五花肉同属猪肉大类 → 槽位 [瘦肉,青椒]，冰箱有猪肉 → 50%（不是 67%）
		dishWithIngredients(2, "菜B", false, `[{"name":"瘦肉","amount":"1"},{"name":"五花肉","amount":"1"},{"name":"青椒","amount":"1"}]`),
	}
	stock := []StockItem{{Name: "番茄", DaysLeft: 999, BatchID: 216}, {Name: "猪肉", DaysLeft: 999, BatchID: 217}}
	matches := matchDishesWithInventory(dishes, stock, 12)
	if len(matches) != 2 {
		t.Fatalf("want 2 matches, got %v", matchNames(matches))
	}
	byName := map[string]FridgeMatch{}
	for _, m := range matches {
		byName[m.Dish.Name] = m
	}
	if m := byName["菜A"]; m.Coverage != 50 {
		t.Fatalf("菜A coverage = %d, want 50 (番茄/西红柿去重后 1/2)", m.Coverage)
	}
	if m := byName["菜B"]; m.Coverage != 50 {
		t.Fatalf("菜B coverage = %d, want 50 (瘦肉/五花肉同属猪肉槽，1/2 而非 67%%)", m.Coverage)
	}
	// 菜B 的 matched 展示保留原始名"瘦肉"，缺失显示青椒
	if m := byName["菜B"]; len(m.Matched) != 1 || m.Matched[0] != "瘦肉" || len(m.Missing) != 1 || m.Missing[0] != "青椒" {
		t.Fatalf("菜B matched=%v missing=%v, want [瘦肉] / [青椒]", m.Matched, m.Missing)
	}
}

func TestDaysLeftFor(t *testing.T) {
	today := time.Date(2026, 10, 27, 15, 0, 0, 0, time.Local) // 带时分，验证按自然日计算
	tests := []struct {
		expiry string
		want   int
	}{
		{"", noExpiryDays},
		{"not-a-date", noExpiryDays},
		{"2026-10-27", 0},  // 今天到期
		{"2026-10-28", 1},  // 明天
		{"2026-10-24", -3}, // 已过期 3 天
	}
	for _, tt := range tests {
		if got := daysLeftFor(tt.expiry, today); got != tt.want {
			t.Fatalf("daysLeftFor(%q) = %d, want %d", tt.expiry, got, tt.want)
		}
	}
}

func TestFoldBatchesByCategory(t *testing.T) {
	today := time.Date(2026, 10, 28, 12, 0, 0, 0, time.Local)
	batches := []models.InventoryBatch{
		{ID: 1, ItemName: "番茄", ExpiryDate: "2026-11-27"}, // 新批 30 天
		{ID: 2, ItemName: "番茄", ExpiryDate: "2026-10-29"}, // 旧批 1 天（先买先吃）
		{ID: 3, ItemName: "猪肉", ExpiryDate: "2026-10-25"}, // 已过期 → 不进推荐
		{ID: 4, ItemName: "排骨", ExpiryDate: "2026-11-01"}, // 与猪肉同大类，未过期 → 保留
		{ID: 5, ItemName: "鸡蛋", ExpiryDate: ""},           // 未设置保质期 → 999 兜底
	}
	stock := foldBatchesByCategory(batches, today)

	byName := map[string]StockItem{}
	for _, si := range stock {
		byName[si.Name] = si
	}
	if len(stock) != 3 {
		t.Fatalf("fold result = %+v, want 3 items (番茄/排骨/鸡蛋)", stock)
	}
	// 同食材两批：保留最早到期的旧批（ID=2，先进先出）
	if byName["番茄"].BatchID != 2 || byName["番茄"].DaysLeft != 1 {
		t.Fatalf("番茄 fold = %+v, want batch 2 with 1 day left", byName["番茄"])
	}
	// 同大类（猪肉/排骨）：未过期那批保留
	if byName["排骨"].BatchID != 4 {
		t.Fatalf("排骨 fold = %+v, want batch 4 (过期猪肉批被排除)", byName["排骨"])
	}
	if _, exists := byName["猪肉"]; exists {
		t.Fatalf("已过期批次不应进入推荐池: %+v", byName["猪肉"])
	}
	// 未设置保质期：999 兜底
	if byName["鸡蛋"].DaysLeft != noExpiryDays {
		t.Fatalf("鸡蛋 DaysLeft = %d, want %d", byName["鸡蛋"].DaysLeft, noExpiryDays)
	}
}

func TestFoldBatchesSameExpiryFIFO(t *testing.T) {
	// 两批同天到期：应保留更早买入的批（先进先出），即使遍历顺序是新批在前
	today := time.Date(2026, 10, 28, 12, 0, 0, 0, time.Local)
	earlyBought := models.InventoryBatch{ID: 10, ItemName: "番茄", ExpiryDate: "2026-11-04", CreatedAt: today.AddDate(0, 0, -5)}
	newBought := models.InventoryBatch{ID: 11, ItemName: "番茄", ExpiryDate: "2026-11-04", CreatedAt: today.AddDate(0, 0, -1)}
	// 新批排前面（模拟 updated_at DESC 的遍历顺序），验证 fold 不依赖遍历顺序
	stock := foldBatchesByCategory([]models.InventoryBatch{newBought, earlyBought}, today)
	if len(stock) != 1 || stock[0].BatchID != 10 {
		t.Fatalf("same-expiry fold = %+v, want batch 10 (更早买入，严格 FIFO)", stock)
	}
}
