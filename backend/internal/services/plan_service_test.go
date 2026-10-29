package services

import (
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"sync"
	"testing"
	"time"
)

func TestAddShoppingListItems(t *testing.T) {
	setupTestDB(t, &models.Dish{}, &models.ShoppingCheck{})
	dish := models.Dish{
		Name:        "番茄牛腩",
		Ingredients: `[{"name":"西红柿","amount":"2个"},{"name":"牛腩","amount":"500g"}]`,
		Seasonings:  `[{"name":"生抽","amount":"1勺"}]`,
		Enabled:     true,
	}
	database.DB.Create(&dish)
	// 清单里已有菜品联动写入的"番茄"（真别名 = 西红柿）
	database.DB.Create(&models.ShoppingCheck{MealDate: "2026-10-28", MealType: "lunch", DishID: 99, ItemName: "番茄"})

	added, err := AddShoppingListItems([]ShoppingItem{
		{Name: "西红柿"},              // 别名已在清单 → 跳过
		{Name: " 牛腩 "},             // 未带用量 → 按菜谱补 500g
		{Name: "生抽", Amount: "2勺"}, // 自带用量优先
		{Name: "牛腩"},               // 同一请求内重复 → 跳过
		{Name: "  "},
	}, dish.ID, dish.Name, "2026-10-28")
	if err != nil || added != 2 {
		t.Fatalf("added=%d err=%v, want 2 nil", added, err)
	}
	var rows []models.ShoppingCheck
	database.DB.Where("meal_type = ?", "extra").Order("id ASC").Find(&rows)
	if len(rows) != 2 || rows[0].ItemName != "牛腩" || rows[0].ItemAmount != "500g" || rows[1].ItemName != "生抽" || rows[1].ItemAmount != "2勺" {
		t.Fatalf("rows = %+v, want 牛腩 500g / 生抽 2勺", rows)
	}

	// 再补一次：全部已存在，返回 0 且不是错误
	if added, err := AddShoppingListItems([]ShoppingItem{{Name: "牛腩"}}, dish.ID, dish.Name, "2026-10-28"); err != nil || added != 0 {
		t.Fatalf("重复补料 added=%d err=%v, want 0 nil", added, err)
	}
}

func TestAddShoppingListItemsConcurrentNoDuplicate(t *testing.T) {
	setupTestDB(t, &models.Dish{}, &models.ShoppingCheck{})
	// 模拟双击补料：并发请求同一食材只能写入一条
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := AddShoppingListItems([]ShoppingItem{{Name: "洋葱"}}, 0, "", "2026-10-28"); err != nil {
				t.Errorf("并发补料返回错误: %v", err)
			}
		}()
	}
	wg.Wait()
	var n int64
	database.DB.Model(&models.ShoppingCheck{}).Where("item_name = ?", "洋葱").Count(&n)
	if n != 1 {
		t.Fatalf("并发补料写入了 %d 条洋葱, want 1", n)
	}
}

func TestAddShoppingListItemsReportsDBError(t *testing.T) {
	// 没有 shopping_checks 表：查询/写入失败必须返回 error，不能伪装成"已存在"的 0
	setupTestDB(t, &models.Dish{})
	if _, err := AddShoppingListItems([]ShoppingItem{{Name: "洋葱"}}, 0, "", "2026-10-28"); err == nil {
		t.Fatalf("数据库失败时应返回 error")
	}
}

func dateFromNow(days int) string {
	return time.Now().AddDate(0, 0, days).Format("2006-01-02")
}

func TestShoppingListInStockIgnoresExpiredAndMatchesAlias(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	for _, name := range []string{"西红柿", "牛奶", "鸡蛋"} {
		database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "lunch", DishID: 1, ItemName: name, ItemAmount: "1个"})
	}
	database.DB.Create(&models.InventoryBatch{ItemName: "番茄", InStock: true, ExpiryDate: dateFromNow(3)})  // 别名
	database.DB.Create(&models.InventoryBatch{ItemName: "番茄", InStock: true, ExpiryDate: ""})              // 未设保质期也算有
	database.DB.Create(&models.InventoryBatch{ItemName: "牛奶", InStock: true, ExpiryDate: dateFromNow(-1)}) // 已过期

	items := shoppingItemsByName(t, today)
	if it := items["西红柿"]; !it.InStock || it.StockBatches != 2 {
		t.Fatalf("冰箱记的是番茄（别名），西红柿应显示家中有 2 批, got %+v", it)
	}
	if it := items["牛奶"]; it.InStock || it.StockBatches != 0 {
		t.Fatalf("已过期的牛奶不算家中有, got %+v", it)
	}
	if it := items["鸡蛋"]; it.InStock {
		t.Fatalf("鸡蛋不在冰箱, got %+v", it)
	}
}

func shoppingItemsByName(t *testing.T, dates ...string) map[string]ShoppingItem {
	t.Helper()
	list, err := BuildShoppingList(dates)
	if err != nil {
		t.Fatalf("BuildShoppingList: %v", err)
	}
	items := map[string]ShoppingItem{}
	for _, cat := range list {
		for _, it := range cat.Items {
			items[it.Name] = it
		}
	}
	return items
}

func TestShoppingListExtraNotDoubleCountedAfterRecording(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	// 先补料（带菜谱用量），再真的记录这道菜：同一份需求，用量只算一次
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "extra", DishID: 7, ItemName: "牛腩", ItemAmount: "500g", Checked: true})
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 7, ItemName: "牛腩", ItemAmount: "500g"})
	// 另一道菜的同名需求照常累加
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "lunch", DishID: 8, ItemName: "牛腩", ItemAmount: "200g"})
	// 没有对应菜品记录的补料照常计入
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "extra", DishID: 9, ItemName: "洋葱", ItemAmount: "1个"})

	items := shoppingItemsByName(t, today)
	if it := items["牛腩"]; it.Amount != "700g" || !it.Checked {
		t.Fatalf("牛腩应为 500g(同一份需求只算一次)+200g = 700g 且保留勾选, got %+v", it)
	}
	if it := items["洋葱"]; it.Amount != "1个" {
		t.Fatalf("独立的补料条目应照常计入, got %+v", it)
	}
}

func TestRemoveShoppingExtraItemOnlyDeletesExtraRows(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "extra", DishID: 3, ItemName: "洋葱", ItemAmount: "1个"})
	database.DB.Create(&models.ShoppingCheck{MealDate: dateFromNow(-3), MealType: "extra", DishID: 3, ItemName: "洋葱"}) // 历史条目不动
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "extra", DishID: 4, ItemName: "牛腩", ItemAmount: "300g"})
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 5, ItemName: "牛腩", ItemAmount: "500g"})

	items := shoppingItemsByName(t, today)
	if !items["洋葱"].Removable || items["牛腩"].Removable {
		t.Fatalf("只来自补料的条目才可删除, got 洋葱=%v 牛腩=%v", items["洋葱"].Removable, items["牛腩"].Removable)
	}

	if removed, err := RemoveShoppingExtraItem("洋葱"); err != nil || removed != 1 {
		t.Fatalf("应删掉今天的补料洋葱 1 条, got %d %v", removed, err)
	}
	var n int64
	database.DB.Model(&models.ShoppingCheck{}).Where("item_name = ?", "洋葱").Count(&n)
	if n != 1 {
		t.Fatalf("历史日期的条目不应被删, 剩 %d 条", n)
	}
	// 混合条目：只删补料那份，菜品联动的用量保留
	if _, err := RemoveShoppingExtraItem("牛腩"); err != nil {
		t.Fatal(err)
	}
	items = shoppingItemsByName(t, today)
	if _, ok := items["洋葱"]; ok {
		t.Fatalf("洋葱应已从清单消失")
	}
	if it := items["牛腩"]; it.Amount != "500g" || it.Removable {
		t.Fatalf("菜品联动的牛腩应保留 500g, got %+v", it)
	}
	if _, err := RemoveShoppingExtraItem("  "); err != ErrEmptyItemName {
		t.Fatalf("空名应返回 ErrEmptyItemName, got %v", err)
	}
}

func TestShoppingListSkipsTapWater(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	// 旧数据里已经写进清单的清水/热水也不显示
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 1, ItemName: "热水", ItemAmount: "700毫升"})
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 1, ItemName: "排骨", ItemAmount: "500g"})
	items := shoppingItemsByName(t, today)
	if _, ok := items["热水"]; ok || len(items) != 1 {
		t.Fatalf("买菜清单不应列出热水, got %v", items)
	}
}

func TestStockInShoppingItems(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{}, &models.InventoryBatch{}, &models.ShoppingItemCategory{})
	today := dateFromNow(0)
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 1, ItemName: "排骨", ItemAmount: "500g", Checked: true})
	database.DB.Create(&models.ShoppingCheck{MealDate: today, MealType: "dinner", DishID: 1, ItemName: "番茄", ItemAmount: "2个", Checked: true})
	database.DB.Create(&models.ShoppingCheck{MealDate: dateFromNow(-2), MealType: "dinner", DishID: 1, ItemName: "排骨", Checked: true}) // 历史条目不动

	added, err := StockInShoppingItems([]StockInItem{{ItemName: "排骨", Quantity: "500g"}, {ItemName: " 番茄 ", Quantity: "2个"}})
	if err != nil || added != 2 {
		t.Fatalf("added=%d err=%v, want 2 nil", added, err)
	}
	var batches []models.InventoryBatch
	database.DB.Order("id ASC").Find(&batches)
	// 保质期按食材字典：排骨归猪肉 3 天，番茄 7 天
	if len(batches) != 2 || batches[0].Quantity != "500g" || batches[0].ExpiryDate != dateFromNow(3) || batches[1].ItemName != "番茄" || batches[1].ExpiryDate != dateFromNow(7) {
		t.Fatalf("批次不符: %+v", batches)
	}
	items := shoppingItemsByName(t, today)
	if it := items["排骨"]; !it.Stocked || !it.InStock {
		t.Fatalf("放进冰箱后应标记已放入且家中有, got %+v", it)
	}
	var oldStocked int64
	database.DB.Model(&models.ShoppingCheck{}).Where("meal_date = ? AND stocked = ?", dateFromNow(-2), true).Count(&oldStocked)
	if oldStocked != 0 {
		t.Fatalf("历史日期的条目不应被标记")
	}

	// 批次用完后，清单里仍记得"已放入过"，不会再提示放一次
	database.DB.Where("item_name = ?", "排骨").Delete(&models.InventoryBatch{})
	if it := shoppingItemsByName(t, today)["排骨"]; !it.Stocked || it.InStock {
		t.Fatalf("批次用完后应仍是已放入、但家中没有, got %+v", it)
	}

	if _, err := StockInShoppingItems([]StockInItem{{ItemName: "鸡蛋"}, {ItemName: "  "}}); err != ErrEmptyItemName {
		t.Fatalf("有空名时应整体拒绝, got %v", err)
	}
	var n int64
	database.DB.Model(&models.InventoryBatch{}).Where("item_name = ?", "鸡蛋").Count(&n)
	if n != 0 {
		t.Fatalf("整体拒绝时不应写入任何一批")
	}
}

func TestToggleHomeInventoryOffRemovesOnlyAvailableBatches(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	database.DB.Create(&models.InventoryBatch{ItemName: "番茄", InStock: true, ExpiryDate: dateFromNow(3)})
	database.DB.Create(&models.InventoryBatch{ItemName: "西红柿", InStock: true, ExpiryDate: dateFromNow(5)})
	database.DB.Create(&models.InventoryBatch{ItemName: "番茄", InStock: true, ExpiryDate: dateFromNow(-2)}) // 已过期：留给冰箱页处理
	database.DB.Create(&models.InventoryBatch{ItemName: "鸡蛋", InStock: true})

	if err := ToggleHomeInventory("西红柿", false); err != nil {
		t.Fatal(err)
	}
	var left []models.InventoryBatch
	database.DB.Order("id ASC").Find(&left)
	if len(left) != 2 || left[0].ExpiryDate != dateFromNow(-2) || left[1].ItemName != "鸡蛋" {
		t.Fatalf("应只移出番茄/西红柿的未过期批次, left %+v", left)
	}
	if err := ToggleHomeInventory("  ", true); err != ErrEmptyItemName {
		t.Fatalf("空名应返回 ErrEmptyItemName, got %v", err)
	}
}

func TestToggleShoppingCheckOnlyTouchesVisibleDates(t *testing.T) {
	setupTestDB(t, &models.ShoppingCheck{})
	for _, offset := range []int{-3, 0, 1, 5} {
		database.DB.Create(&models.ShoppingCheck{MealDate: dateFromNow(offset), MealType: "lunch", DishID: 1, ItemName: "鸡蛋"})
	}
	if err := ToggleShoppingCheck("鸡蛋", true); err != nil {
		t.Fatal(err)
	}
	var rows []models.ShoppingCheck
	database.DB.Order("meal_date ASC").Find(&rows)
	got := []bool{rows[0].Checked, rows[1].Checked, rows[2].Checked, rows[3].Checked}
	want := []bool{false, true, true, false}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("只应勾选今天/明天的条目, checked = %v (dates %s..%s)", got, rows[0].MealDate, rows[3].MealDate)
		}
	}
}

func TestAvailableBatchCountsDistinctFoods(t *testing.T) {
	setupTestDB(t, &models.InventoryBatch{})
	for i := 0; i < 10; i++ {
		database.DB.Create(&models.InventoryBatch{ItemName: "番茄", InStock: true})
	}
	database.DB.Create(&models.InventoryBatch{ItemName: "西红柿", InStock: true})
	counts, err := availableBatchCounts()
	if err != nil || len(counts) != 1 || counts["番茄"] != 11 {
		t.Fatalf("10 批番茄 + 1 批西红柿是同一种食材（库存成就只算 1 项）, got %v %v", counts, err)
	}
}

func TestCompactShoppingAmounts(t *testing.T) {
	tests := []struct {
		name    string
		amounts []string
		want    string
	}{
		{name: "same unit sums", amounts: []string{"1个", "2个"}, want: "3个"},
		{name: "different units stay separate", amounts: []string{"1个", "4颗"}, want: "1个+4颗"},
		{name: "different unit order is stable", amounts: []string{"4颗", "1个"}, want: "1个+4颗"},
		{name: "text amounts dedupe", amounts: []string{"适量", "适量", "适量"}, want: "适量"},
		{name: "mixed text and numeric", amounts: []string{"适量", "1块", "适量"}, want: "适量+1块"},
		{name: "existing plus values compact", amounts: []string{"3个+4个"}, want: "7个"},
		{name: "no unit numeric sums", amounts: []string{"1", "2"}, want: "3"},
		{name: "decimal values sum", amounts: []string{"0.5斤", "1斤"}, want: "1.5斤"},
		{name: "empty defaults to suitable amount", amounts: []string{"", "  "}, want: "适量"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := compactShoppingAmounts(tt.amounts); got != tt.want {
				t.Fatalf("compactShoppingAmounts(%v) = %q, want %q", tt.amounts, got, tt.want)
			}
		})
	}
}

func TestSortShoppingItems(t *testing.T) {
	items := []ShoppingItem{
		{Name: "tomato", Amount: "2个"},
		{Name: "egg", Amount: "3个", Checked: true},
		{Name: "egg", Amount: "2个"},
		{Name: "apple", Amount: "1个", InStock: true},
	}

	sortShoppingItems(items)

	got := []string{
		items[0].Name + ":" + items[0].Amount,
		items[1].Name + ":" + items[1].Amount,
		items[2].Name + ":" + items[2].Amount,
		items[3].Name + ":" + items[3].Amount,
	}
	want := []string{"egg:2个", "tomato:2个", "egg:3个", "apple:1个"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("sorted[%d] = %q, want %q; full order: %v", i, got[i], want[i], got)
		}
	}
}

func TestShoppingItemPriority(t *testing.T) {
	tests := []struct {
		item ShoppingItem
		want int
	}{
		{item: ShoppingItem{Name: "盐"}, want: 0},
		{item: ShoppingItem{Name: "盐", Checked: true}, want: 1},
		{item: ShoppingItem{Name: "盐", InStock: true}, want: 2},
		{item: ShoppingItem{Name: "盐", Checked: true, InStock: true}, want: 2},
	}

	for _, tt := range tests {
		if got := shoppingItemPriority(tt.item); got != tt.want {
			t.Fatalf("shoppingItemPriority(%+v) = %d, want %d", tt.item, got, tt.want)
		}
	}
}

func TestBuildShoppingCategoryExact(t *testing.T) {
	terms := map[string][]string{
		"蔬菜": {"番茄", "西兰花"},
		"肉类": {"鸡蛋"},
		"无效": {"不会加入"},
	}

	got := buildShoppingCategoryExact(terms)
	if got["番茄"] != "蔬菜" {
		t.Fatalf("番茄 category = %q, want 蔬菜", got["番茄"])
	}
	if got["鸡蛋"] != "肉类" {
		t.Fatalf("鸡蛋 category = %q, want 肉类", got["鸡蛋"])
	}
	if _, exists := got["不会加入"]; exists {
		t.Fatalf("invalid category term should be ignored")
	}
}

func TestClassifyShoppingItem(t *testing.T) {
	overrides := map[string]string{"紫菜": "其他"}
	tests := []struct {
		name string
		want string
	}{
		{name: "番茄", want: "蔬菜"},
		{name: "西红柿", want: "蔬菜"},
		{name: "西兰花", want: "蔬菜"},
		{name: "豆腐", want: "蔬菜"},
		{name: "青椒", want: "蔬菜"},
		{name: "小米辣", want: "蔬菜"},
		{name: "金针菇", want: "蔬菜"},
		{name: "土豆", want: "蔬菜"},
		{name: "玉米", want: "蔬菜"},
		{name: "猪肉末", want: "肉类"},
		{name: "鸡蛋", want: "肉类"},
		{name: "鸡翅", want: "肉类"},
		{name: "牛腩", want: "肉类"},
		{name: "虾仁", want: "肉类"},
		{name: "鱿鱼", want: "肉类"},
		{name: "花椒粉", want: "配料"},
		{name: "豆瓣酱", want: "配料"},
		{name: "辣椒粉", want: "配料"},
		{name: "生抽", want: "配料"},
		{name: "老抽", want: "配料"},
		{name: "料酒", want: "配料"},
		{name: "鸡精", want: "配料"},
		{name: "玉米淀粉", want: "配料"},
		{name: "番茄酱", want: "配料"},
		{name: "蛋黄酱", want: "配料"},
		{name: "面粉", want: "其他"},
		{name: "糯米粉", want: "其他"},
		{name: "粉丝", want: "其他"},
		{name: "鸡蛋面", want: "其他"},
		{name: "可乐", want: "其他"},
		{name: "紫菜", want: "其他"},
		{name: "黄瓜段", want: "蔬菜"},
		{name: "五花肉片", want: "肉类"},
		{name: "黑胡椒碎", want: "配料"},
		// 种子菜谱里过去被归到"其他"的肉类、蔬菜
		{name: "猪肋排", want: "肉类"},
		{name: "三黄鸡", want: "肉类"},
		{name: "大虾", want: "肉类"},
		{name: "鲤鱼", want: "肉类"},
		{name: "毛肚", want: "肉类"},
		{name: "腊肠", want: "肉类"},
		{name: "咸蛋黄", want: "肉类"},
		{name: "叉烧", want: "肉类"},
		{name: "折耳根", want: "蔬菜"},
		{name: "韭黄", want: "蔬菜"},
		{name: "攸县香干", want: "蔬菜"},
		// 带动物字但不是肉
		{name: "鸡腿菇", want: "蔬菜"},
		{name: "牛肝菌", want: "蔬菜"},
		{name: "羊肚菌", want: "蔬菜"},
		{name: "鱼腥草", want: "蔬菜"},
		{name: "全脂牛奶", want: "其他"},
		{name: "奶白菜", want: "蔬菜"},
		{name: "猪油", want: "配料"},
		{name: "捆鸡", want: "蔬菜"},
		{name: "素鸡", want: "蔬菜"},
		{name: "虾米", want: "配料"},
		{name: "瑶柱", want: "肉类"},
		{name: "花蛤", want: "肉类"},
		{name: "田螺", want: "肉类"},
		{name: "秋葵", want: "蔬菜"},
		{name: "紫甘蓝", want: "蔬菜"},
		{name: "芥兰", want: "蔬菜"},
		{name: "魔芋", want: "蔬菜"},
		{name: "鸡蛋面", want: "其他"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := classifyShoppingItem(tt.name, overrides); got != tt.want {
				t.Fatalf("classifyShoppingItem(%q) = %q, want %q", tt.name, got, tt.want)
			}
		})
	}
}
