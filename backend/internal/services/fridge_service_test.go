package services

import (
	"fmt"
	"ninimenu/internal/database"
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
	if matches[0].Missing == nil || matches[0].Matched == nil || matches[0].UsingUrgent == nil {
		t.Fatalf("slices must not be nil: matched=%v missing=%v urgent=%v", matches[0].Matched, matches[0].Missing, matches[0].UsingUrgent)
	}
}

func TestParseIngredientList(t *testing.T) {
	tests := []struct {
		note string
		raw  string
		want []DishIngredient
	}{
		{"标准对象数组", `[{"name":"鸡蛋","amount":"3个"},{"name":" 番茄 ","amount":" 2个 "}]`, []DishIngredient{{"鸡蛋", "3个"}, {"番茄", "2个"}}},
		{"旧字符串数组", `["鸡蛋","番茄"]`, []DishIngredient{{"鸡蛋", ""}, {"番茄", ""}}},
		{"混写逐项兼容", `["鸡蛋",{"name":"番茄","amount":"1个"}]`, []DishIngredient{{"鸡蛋", ""}, {"番茄", "1个"}}},
		{"坏项只跳过该项", `[{"name":"鸡蛋","amount":3},{"name":"番茄"},null,""]`, []DishIngredient{{"番茄", ""}}},
		{"非法 JSON", `not-json`, nil},
		{"空数组", `[]`, nil},
	}
	for _, tt := range tests {
		got := ParseIngredientList(tt.raw)
		if len(got) != len(tt.want) {
			t.Fatalf("[%s] got %v, want %v", tt.note, got, tt.want)
		}
		for i := range tt.want {
			if got[i] != tt.want[i] {
				t.Fatalf("[%s] got[%d] = %+v, want %+v", tt.note, i, got[i], tt.want[i])
			}
		}
	}
}

func TestConsumeKind(t *testing.T) {
	tests := []struct{ req, stock, want string }{
		{"排骨", "排骨", consumeExact},
		{"西红柿", "番茄", consumeExact},   // 真别名
		{"排骨", "猪肉", consumeGeneric},  // 库存是泛称
		{"猪肉", "五花肉", consumeGeneric}, // 菜谱是泛称
		{"排骨", "五花肉", consumeSimilar}, // 两个具体部位：不能互相默认扣
		{"排骨", "牛腩", ""},              // 不同大类
		{"番茄", "鸡蛋", ""},
	}
	for _, tt := range tests {
		if got := consumeKind(tt.req, tt.stock); got != tt.want {
			t.Fatalf("consumeKind(%q, %q) = %q, want %q", tt.req, tt.stock, got, tt.want)
		}
	}
}

func slotByName(slots []ConsumptionSlot, name string) (ConsumptionSlot, bool) {
	for _, s := range slots {
		if s.RequestedName == name {
			return s, true
		}
	}
	return ConsumptionSlot{}, false
}

func batchIDs(s ConsumptionSlot) []uint {
	ids := make([]uint, len(s.Batches))
	for i, b := range s.Batches {
		ids[i] = b.BatchID
	}
	return ids
}

func TestMatchDishConsumptionNeverDefaultsToOtherCut(t *testing.T) {
	// DeepSeek 复现场景：菜要排骨，冰箱只有五花肉（明天到期）+ 排骨（下周到期）。
	// 旧实现按大类先进先出会删掉五花肉；现在必须默认扣排骨，五花肉只作相近部位参考。
	today := time.Date(2026, 10, 28, 12, 0, 0, 0, time.Local)
	dish := dishWithIngredients(1, "红烧排骨", false, `[{"name":"排骨","amount":"500g"},{"name":"小葱","amount":"1根"}]`)
	batches := []models.InventoryBatch{
		{ID: 1, ItemName: "五花肉", ExpiryDate: "2026-10-29"},
		{ID: 2, ItemName: "排骨", ExpiryDate: "2026-11-04"},
		{ID: 3, ItemName: "小葱", ExpiryDate: "2026-10-30"},
	}
	slots := matchDishConsumption(dish, batches, today)
	if len(slots) != 1 {
		t.Fatalf("常备配料不参与扣减，应只有排骨一个槽位, got %+v", slots)
	}
	s := slots[0]
	if s.RequestedName != "排骨" || s.Amount != "500g" {
		t.Fatalf("slot = %+v, want 排骨 500g", s)
	}
	if s.SuggestedBatchID != 2 {
		t.Fatalf("默认应扣排骨批次 2, got %d (batches %v)", s.SuggestedBatchID, batchIDs(s))
	}
	if ids := batchIDs(s); len(ids) != 2 || ids[0] != 2 || ids[1] != 1 {
		t.Fatalf("排序应为 精确排骨 → 相近五花肉, got %v", ids)
	}
	if s.Batches[1].Kind != consumeSimilar || s.Batches[1].StockName != "五花肉" {
		t.Fatalf("五花肉应标为 similar, got %+v", s.Batches[1])
	}
}

func TestMatchDishConsumptionFIFOAndExpired(t *testing.T) {
	today := time.Date(2026, 10, 28, 12, 0, 0, 0, time.Local)
	dish := dishWithIngredients(1, "番茄炒蛋", false, `[{"name":"西红柿","amount":"2个"},{"name":"番茄","amount":"1个"},{"name":"鸡蛋","amount":"3个"}]`)
	batches := []models.InventoryBatch{
		{ID: 10, ItemName: "番茄", ExpiryDate: "2026-11-05", CreatedAt: today.AddDate(0, 0, -1)},
		{ID: 11, ItemName: "番茄", ExpiryDate: "2026-10-30", CreatedAt: today.AddDate(0, 0, -4)},
		{ID: 12, ItemName: "番茄", ExpiryDate: "2026-10-25"}, // 已过期：列出但不默认扣
		{ID: 20, ItemName: "鸡蛋", ExpiryDate: "2026-10-26"}, // 唯一一批已过期
	}
	slots := matchDishConsumption(dish, batches, today)
	if len(slots) != 2 {
		t.Fatalf("番茄/西红柿是同一食材应合并，期望 2 个槽位, got %+v", slots)
	}
	tomato, ok := slotByName(slots, "西红柿")
	if !ok {
		t.Fatalf("槽位名应保留菜谱首次写法'西红柿', got %+v", slots)
	}
	if tomato.SuggestedBatchID != 11 {
		t.Fatalf("应默认扣最早到期的未过期批 11, got %d", tomato.SuggestedBatchID)
	}
	if ids := batchIDs(tomato); len(ids) != 3 || ids[0] != 11 || ids[1] != 10 || ids[2] != 12 {
		t.Fatalf("番茄批次顺序应为 11(临期) → 10 → 12(过期), got %v", ids)
	}
	egg, _ := slotByName(slots, "鸡蛋")
	if egg.SuggestedBatchID != 0 || len(egg.Batches) != 1 {
		t.Fatalf("只有过期批次时列出但不默认扣, got %+v", egg)
	}
}

func TestMatchDishConsumptionBatchAssignedOnce(t *testing.T) {
	today := time.Date(2026, 10, 28, 12, 0, 0, 0, time.Local)
	// 菜谱同时写了瘦肉和排骨：排骨批精确归排骨槽，不能再作为瘦肉的相近部位出现
	dish := dishWithIngredients(1, "排骨炒肉", false, `[{"name":"瘦肉","amount":"100g"},{"name":"排骨","amount":"300g"}]`)
	batches := []models.InventoryBatch{{ID: 5, ItemName: "排骨", ExpiryDate: "2026-11-01"}}
	slots := matchDishConsumption(dish, batches, today)
	if len(slots) != 1 || slots[0].RequestedName != "排骨" || slots[0].SuggestedBatchID != 5 {
		t.Fatalf("排骨批只应归排骨槽, got %+v", slots)
	}

	// 菜谱写泛称"猪肉"、冰箱是具体部位：泛称匹配，可以默认扣最早到期的
	generic := dishWithIngredients(2, "青椒炒肉", false, `[{"name":"猪肉","amount":"200g"}]`)
	batches = []models.InventoryBatch{
		{ID: 6, ItemName: "五花肉", ExpiryDate: "2026-11-03"},
		{ID: 7, ItemName: "瘦肉", ExpiryDate: "2026-10-30"},
	}
	slots = matchDishConsumption(generic, batches, today)
	if len(slots) != 1 || slots[0].SuggestedBatchID != 7 || slots[0].Batches[0].Kind != consumeGeneric {
		t.Fatalf("泛称猪肉应默认扣最早到期的瘦肉批 7, got %+v", slots)
	}
}

func TestMatchDishConsumptionHeadRequestStrictFIFO(t *testing.T) {
	today := time.Date(2026, 10, 28, 12, 0, 0, 0, time.Local)
	// 菜谱写泛称"猪肉"：猪肉批（精确，6 天）和瘦肉批（泛称，明天到期）都完全满足，按到期先后默认扣瘦肉
	dish := dishWithIngredients(1, "青椒炒肉", false, `[{"name":"猪肉","amount":"200g"}]`)
	batches := []models.InventoryBatch{
		{ID: 1, ItemName: "猪肉", ExpiryDate: "2026-11-03"},
		{ID: 2, ItemName: "瘦肉", ExpiryDate: "2026-10-29"},
	}
	slots := matchDishConsumption(dish, batches, today)
	if len(slots) != 1 || slots[0].SuggestedBatchID != 2 {
		t.Fatalf("泛称菜谱应严格先进先出默认扣瘦肉批 2, got %+v", slots)
	}

	// 菜谱写具体部位"排骨"：精确的排骨批优先于更早到期的泛称"猪肉"批（猪肉未必是排骨）
	ribs := dishWithIngredients(2, "红烧排骨", false, `[{"name":"排骨","amount":"500g"}]`)
	batches = []models.InventoryBatch{
		{ID: 3, ItemName: "排骨", ExpiryDate: "2026-11-03"},
		{ID: 4, ItemName: "猪肉", ExpiryDate: "2026-10-29"},
	}
	slots = matchDishConsumption(ribs, batches, today)
	if len(slots) != 1 || slots[0].SuggestedBatchID != 3 {
		t.Fatalf("具体部位菜谱应精确优先默认扣排骨批 3, got %+v", slots)
	}
}

func TestMatchDishConsumptionRoundRobinAcrossSlots(t *testing.T) {
	today := time.Date(2026, 10, 28, 12, 0, 0, 0, time.Local)
	// 菜谱两个部位都要，冰箱是两批泛称"猪肉"：每个槽位各分到一批，而不是第一个槽位全拿
	dish := dishWithIngredients(1, "双拼", false, `[{"name":"瘦肉","amount":"100g"},{"name":"五花肉","amount":"100g"}]`)
	batches := []models.InventoryBatch{
		{ID: 1, ItemName: "猪肉", ExpiryDate: "2026-11-05"},
		{ID: 2, ItemName: "猪肉", ExpiryDate: "2026-10-30"},
	}
	slots := matchDishConsumption(dish, batches, today)
	if len(slots) != 2 {
		t.Fatalf("两个槽位都应有候选, got %+v", slots)
	}
	lean, _ := slotByName(slots, "瘦肉")
	belly, _ := slotByName(slots, "五花肉")
	if lean.SuggestedBatchID != 2 || belly.SuggestedBatchID != 1 {
		t.Fatalf("先到期的批给第一个槽位、另一批给第二个槽位, got 瘦肉=%d 五花肉=%d", lean.SuggestedBatchID, belly.SuggestedBatchID)
	}
}

func TestMatchDishConsumptionEmpty(t *testing.T) {
	today := time.Date(2026, 10, 28, 12, 0, 0, 0, time.Local)
	dish := dishWithIngredients(1, "番茄炒蛋", false, `[{"name":"番茄","amount":"2个"}]`)
	slots := matchDishConsumption(dish, []models.InventoryBatch{{ID: 1, ItemName: "牛腩"}}, today)
	if slots == nil || len(slots) != 0 {
		t.Fatalf("无候选时应返回空切片（JSON 为 [] 而非 null）, got %#v", slots)
	}
}

func TestConsumeInventoryBatches(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	for _, name := range []string{"番茄", "鸡蛋", "排骨"} {
		if err := database.DB.Create(&models.InventoryBatch{ItemName: name, InStock: true, ExpiryDate: "2026-11-01"}).Error; err != nil {
			t.Fatalf("写入批次 %s 失败: %v", name, err)
		}
	}
	var all []models.InventoryBatch
	database.DB.Order("id ASC").Find(&all)
	// 其中一个 id 不存在（已被别处移出）：不算错误，按实际移除数返回
	removed, err := ConsumeInventoryBatches([]uint{all[0].ID, all[2].ID, 9999})
	if err != nil || removed != 2 {
		t.Fatalf("removed=%d err=%v, want 2 nil", removed, err)
	}
	var left []models.InventoryBatch
	database.DB.Find(&left)
	if len(left) != 1 || left[0].ItemName != "鸡蛋" {
		t.Fatalf("应只剩鸡蛋, got %+v", left)
	}
	if removed, err := ConsumeInventoryBatches(nil); err != nil || removed != 0 {
		t.Fatalf("空列表应直接返回 0, got %d %v", removed, err)
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
