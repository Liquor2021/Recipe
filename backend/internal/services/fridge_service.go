package services

import (
	"encoding/json"
	"errors"
	"math"
	"ninimenu/internal/database"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"sort"
	"strconv"
	"strings"
	"time"

	"gorm.io/gorm"
)

// FridgeMatch 一道菜与当前冰箱存货的匹配结果
type FridgeMatch struct {
	Dish         models.Dish `json:"dish"`
	Matched      []string    `json:"matched"` // 命中的菜谱食材名
	Missing      []string    `json:"missing"`
	MatchedCount int         `json:"matched_count"`
	Coverage     int         `json:"coverage"` // 0-100，主要食材命中率
	UsingUrgent  []string    `json:"using_urgent"`
	// Have 与 Matched 一一对应：冰箱里实际对上的是什么（卡片显示冰箱里的真实名字）
	Have []FridgeHave `json:"have"`
}

// FridgeHave 推荐卡片上"有"的一项
type FridgeHave struct {
	Stock  string `json:"stock"`  // 冰箱里的名字（如"五花肉"）
	Recipe string `json:"recipe"` // 对应菜谱里的哪样（如"瘦肉"）
	// Substitute 不是同一种、只是同一大类（五花肉当瘦肉用）；同名或真别名（番茄/西红柿）为 false
	Substitute bool `json:"substitute"`
}

// StockItem 参与匹配的一批库存
type StockItem struct {
	BatchID   uint
	Name      string
	DaysLeft  int // 距过期的天数；999 表示未设置保质期
	CreatedAt time.Time
}

const noExpiryDays = 999

// DishIngredient 菜谱里的一项食材/调料
type DishIngredient struct {
	Name   string
	Amount string
}

// ParseIngredientList 解析菜品的食材/调料 JSON，兼容两种存储格式：
// 标准对象数组 [{"name":"鸡蛋","amount":"3个"}]，以及旧数据/手工录入的
// 字符串数组 ["鸡蛋","番茄"]（字符串即名字，无数量）；两种混写也逐项兼容。
// 单项解析失败只跳过该项，不让整份清单失效。
func ParseIngredientList(raw string) []DishIngredient {
	var items []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil
	}
	out := make([]DishIngredient, 0, len(items))
	for _, item := range items {
		var name string
		if err := json.Unmarshal(item, &name); err == nil {
			if name = strings.TrimSpace(name); name != "" {
				out = append(out, DishIngredient{Name: name})
			}
			continue
		}
		var obj struct {
			Name   string `json:"name"`
			Amount string `json:"amount"`
		}
		if err := json.Unmarshal(item, &obj); err != nil {
			continue
		}
		if obj.Name = strings.TrimSpace(obj.Name); obj.Name != "" {
			out = append(out, DishIngredient{Name: obj.Name, Amount: strings.TrimSpace(obj.Amount)})
		}
	}
	return out
}

// ParseDishIngredientNames 取菜品主要食材名（保持顺序、去重），调料不参与匹配。
func ParseDishIngredientNames(dish models.Dish) []string {
	ings := ParseIngredientList(dish.Ingredients)
	names := make([]string, 0, len(ings))
	for _, ing := range ings {
		names = append(names, ing.Name)
	}
	return dedupeNames(names)
}

func dedupeNames(names []string) []string {
	seen := make(map[string]bool, len(names))
	out := make([]string, 0, len(names))
	for _, name := range names {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// daysLeftFor 计算某批次距过期的天数；未设置保质期返回 noExpiryDays
func daysLeftFor(expiryDate string, today time.Time) int {
	if expiryDate == "" {
		return noExpiryDays
	}
	expiry, err := time.ParseInLocation("2006-01-02", expiryDate, time.Local)
	if err != nil {
		return noExpiryDays
	}
	todayMorning := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.Local)
	return int(expiry.Sub(todayMorning).Hours() / 24)
}

// matchDishesWithInventory 纯函数匹配：命中率优先，同命中率下优先用掉临期食材。
// 这是"能做什么"的宽松推荐语义，不能用来决定扣哪批库存（扣库存见 matchDishConsumption）。
// 槽位去重与命中判断都按食材大类（CategoryOf）：真别名（番茄/西红柿）和部位形态
// （瘦肉/五花肉）不会虚增分母或命中数——一块猪肉不能同时算作两种主料。
// 同品类多批次库存由调用方折叠为最早到期的一批（stock 传入前已保证）。
func matchDishesWithInventory(dishes []models.Dish, stock []StockItem, limit int) []FridgeMatch {
	stockByName := make(map[string]StockItem, len(stock))
	for _, item := range stock {
		stockByName[ingredients.CategoryOf(item.Name)] = item
	}

	matches := make([]FridgeMatch, 0)
	for _, dish := range dishes {
		ings := ParseDishIngredientNames(dish)
		// 只统计非常备配料的主料，葱姜蒜不进分母；按大类槽位去重（保留首个原始名展示）
		mainIngs := make([]string, 0, len(ings))
		seenCategory := make(map[string]bool, len(ings))
		for _, ing := range ings {
			if ingredients.IsStaple(ing) {
				continue
			}
			cat := ingredients.CategoryOf(ing)
			if seenCategory[cat] {
				continue
			}
			seenCategory[cat] = true
			mainIngs = append(mainIngs, ing)
		}
		if len(mainIngs) == 0 {
			continue
		}
		// 初始化为空切片，避免全命中/全缺失时 JSON 序列化成 null
		matched := []string{}
		missing := []string{}
		usingUrgent := []string{}
		have := []FridgeHave{}
		for _, ing := range mainIngs {
			item, ok := stockByName[ingredients.CategoryOf(ing)]
			if !ok {
				missing = append(missing, ing)
				continue
			}
			matched = append(matched, ing)
			have = append(have, FridgeHave{
				Stock:      item.Name,
				Recipe:     ing,
				Substitute: ingredients.Normalize(item.Name) != ingredients.Normalize(ing),
			})
			if item.DaysLeft <= 4 {
				usingUrgent = append(usingUrgent, ing)
			}
		}
		if len(matched) == 0 {
			continue
		}
		matches = append(matches, FridgeMatch{
			Dish:         dish,
			Matched:      matched,
			Missing:      missing,
			MatchedCount: len(matched),
			Coverage:     len(matched) * 100 / len(mainIngs),
			UsingUrgent:  usingUrgent,
			Have:         have,
		})
	}

	sort.SliceStable(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.Coverage != b.Coverage {
			return a.Coverage > b.Coverage
		}
		// 同命中率下，能消耗临期食材的排前面
		if len(a.UsingUrgent) != len(b.UsingUrgent) {
			return len(a.UsingUrgent) > len(b.UsingUrgent)
		}
		if a.MatchedCount != b.MatchedCount {
			return a.MatchedCount > b.MatchedCount
		}
		if a.Dish.Favorite != b.Dish.Favorite {
			return a.Dish.Favorite
		}
		return a.Dish.ID < b.Dish.ID
	})

	if limit > 0 && len(matches) > limit {
		matches = matches[:limit]
	}
	return matches
}

// ListInventoryBatches 冰箱全部批次：按食材名分组有序（组内临期在前，未设置的最后）
func ListInventoryBatches() []models.InventoryBatch {
	batches := []models.InventoryBatch{}
	database.DB.Where("in_stock = ?", true).
		Order("item_name ASC, updated_at DESC").Find(&batches)
	today := time.Now()
	sort.SliceStable(batches, func(i, j int) bool {
		if batches[i].ItemName != batches[j].ItemName {
			return batches[i].ItemName < batches[j].ItemName
		}
		di, dj := daysLeftFor(batches[i].ExpiryDate, today), daysLeftFor(batches[j].ExpiryDate, today)
		return di < dj
	})
	return batches
}

// ErrEmptyItemName 食材名为空（调用方应按参数错误处理）
var ErrEmptyItemName = errors.New("食材名称为空")

// newInventoryBatch 组装一批库存；expiryDate 为空时按食材字典自动设默认保质期
func newInventoryBatch(itemName, quantity, expiryDate string) models.InventoryBatch {
	if expiryDate == "" {
		expiryDate = time.Now().AddDate(0, 0, ingredients.ShelfLifeFor(itemName)).Format("2006-01-02")
	}
	return models.InventoryBatch{
		ItemName:   itemName,
		InStock:    true,
		Quantity:   strings.TrimSpace(quantity),
		ExpiryDate: expiryDate,
	}
}

// CreateInventoryBatch 新增一批食材：空名返回 ErrEmptyItemName；expiryDate 为空时按食材字典自动设默认保质期
func CreateInventoryBatch(itemName string, quantity string, expiryDate string) error {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return ErrEmptyItemName
	}
	batch := newInventoryBatch(itemName, quantity, expiryDate)
	return database.DB.Create(&batch).Error
}

// UpdateInventoryBatch 更新某批次的质量字段（数量/保质期）；批次不存在返回 found=false
func UpdateInventoryBatch(id uint, quantity string, expiryDate string) (bool, error) {
	var batch models.InventoryBatch
	if err := database.DB.First(&batch, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		return false, err
	}
	batch.Quantity = strings.TrimSpace(quantity)
	batch.ExpiryDate = strings.TrimSpace(expiryDate)
	return true, database.DB.Save(&batch).Error
}

// RemoveInventoryBatch 移出单批食材；批次不存在返回 removed=false
func RemoveInventoryBatch(id uint) (bool, error) {
	res := database.DB.Delete(&models.InventoryBatch{}, id)
	return res.RowsAffected > 0, res.Error
}

// RemoveInventoryItem 移出某食材名下的全部批次（冰箱页按食材名整组移出）
func RemoveInventoryItem(itemName string) error {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return ErrEmptyItemName
	}
	return database.DB.Where("item_name = ?", itemName).Delete(&models.InventoryBatch{}).Error
}

// availableBatchCounts 按真别名归一的食材名统计"家中可用"批次数：已过期的不算
// （过期了就得重新买）。买菜清单"家中有"与库存类成就共用这一口径。
func availableBatchCounts() (map[string]int, error) {
	var batches []models.InventoryBatch
	if err := database.DB.Where("in_stock = ?", true).Find(&batches).Error; err != nil {
		return nil, err
	}
	today := time.Now()
	counts := make(map[string]int, len(batches))
	for _, b := range batches {
		if daysLeftFor(b.ExpiryDate, today) < 0 {
			continue
		}
		counts[ingredients.Normalize(b.ItemName)]++
	}
	return counts, nil
}

// removeAvailableBatches 移出与 itemName 同一食材（含真别名）的全部未过期批次，返回移出数。
// 买菜清单取消"家中有"用：已过期批次不在"家中有"口径里，留给冰箱页的临期提醒处理。
func removeAvailableBatches(itemName string) (int64, error) {
	var batches []models.InventoryBatch
	if err := database.DB.Where("in_stock = ?", true).Find(&batches).Error; err != nil {
		return 0, err
	}
	key := ingredients.Normalize(itemName)
	today := time.Now()
	ids := make([]uint, 0)
	for _, b := range batches {
		if ingredients.Normalize(b.ItemName) == key && daysLeftFor(b.ExpiryDate, today) >= 0 {
			ids = append(ids, b.ID)
		}
	}
	return ConsumeInventoryBatches(ids)
}

// UrgentInventoryItems 临期/已过期批次（含今天过期），供首页提醒条使用
func UrgentInventoryItems() []models.InventoryBatch {
	batches := ListInventoryBatches()
	today := time.Now()
	urgent := []models.InventoryBatch{}
	for _, b := range batches {
		if daysLeftFor(b.ExpiryDate, today) <= 2 {
			urgent = append(urgent, b)
		}
	}
	return urgent
}

// foldBatchesByCategory 纯函数：把库存批次折叠成参与匹配的库存项。
// 已过期批次排除（只提醒不推荐）；同大类多批次保留最早到期的一批，
// 同日到期时保留更早买入的一批（严格先进先出）。
func foldBatchesByCategory(batches []models.InventoryBatch, today time.Time) []StockItem {
	bestByCategory := make(map[string]StockItem)
	for _, b := range batches {
		daysLeft := daysLeftFor(b.ExpiryDate, today)
		if daysLeft < 0 {
			continue
		}
		si := StockItem{BatchID: b.ID, Name: b.ItemName, DaysLeft: daysLeft, CreatedAt: b.CreatedAt}
		cat := ingredients.CategoryOf(b.ItemName)
		keep := false
		if cur, ok := bestByCategory[cat]; !ok {
			keep = true
		} else if daysLeft < cur.DaysLeft {
			keep = true
		} else if daysLeft == cur.DaysLeft && b.CreatedAt.Before(cur.CreatedAt) {
			keep = true
		}
		if keep {
			bestByCategory[cat] = si
		}
	}
	stock := make([]StockItem, 0, len(bestByCategory))
	for _, si := range bestByCategory {
		stock = append(stock, si)
	}
	sort.Slice(stock, func(i, j int) bool { return stock[i].Name < stock[j].Name })
	return stock
}

// MatchFridgeRecipes 用冰箱现有食材推荐能做的菜
func MatchFridgeRecipes(limit int) []FridgeMatch {
	if limit <= 0 || limit > 50 {
		limit = 12
	}
	var dishes []models.Dish
	database.DB.Where("enabled = ?", true).Find(&dishes)
	// strict 忌口：命中的菜不出现在清冰箱推荐里（avoid 模式不影响，推荐列表本就供人挑选）
	dishes = applyDislikeMode(dishes, loadFamilyDislikeConfig())
	batches := ListInventoryBatches()
	stock := foldBatchesByCategory(batches, time.Now())
	matches := matchDishesWithInventory(dishes, stock, limit)
	if matches == nil {
		return []FridgeMatch{}
	}
	return matches
}

// 扣库存匹配类型。推荐用宽松的大类语义（有五花肉也算"能做排骨"），
// 扣库存必须精确：删错批次是真实数据损失。
const (
	consumeExact   = "exact"   // 同名或真别名（番茄=西红柿）
	consumeGeneric = "generic" // 一方是大类泛称（库存"猪肉" ↔ 菜谱"排骨"）
	consumeSimilar = "similar" // 同大类的不同部位（排骨 vs 五花肉），只供参考，默认不勾选
)

// ConsumptionBatch 做完菜后可扣减的一个库存批次
type ConsumptionBatch struct {
	BatchID    uint   `json:"batch_id"`
	StockName  string `json:"stock_name"`
	Quantity   string `json:"quantity"`
	ExpiryDate string `json:"expiry_date"`
	DaysLeft   int    `json:"days_left"` // noExpiryDays 表示未设置保质期
	Kind       string `json:"kind"`
	// RemainingHint 按菜谱用量（1 份）算出的剩余量，如库存"6个"、菜谱"3个" → "3个"；
	// 单位对不上、无法解析或会用完时为空。只是建议值，用户在弹层里可以改
	RemainingHint string    `json:"remaining_hint"`
	createdAt     time.Time // 先进先出排序用，不输出
}

// ConsumptionSlot 菜谱里的一项主料，及冰箱里能对应上的批次
type ConsumptionSlot struct {
	RequestedName string `json:"requested_name"`
	Amount        string `json:"amount"`
	// Batches 按"默认可扣 → 先进先出"排序：未过期的精确/泛称批次在前，过期与相近部位在后
	Batches []ConsumptionBatch `json:"batches"`
	// SuggestedBatchID 默认勾选的批次（最早到期的未过期精确/泛称批次），0 表示不建议默认扣
	SuggestedBatchID uint `json:"suggested_batch_id"`
}

// ConsumptionMatch 一道菜的扣库存候选
type ConsumptionMatch struct {
	DishID uint              `json:"dish_id"`
	Slots  []ConsumptionSlot `json:"slots"`
}

// consumeKind 菜谱食材 req 与库存名 stock 的扣减匹配关系，不相关返回空串
func consumeKind(req, stock string) string {
	rn, sn := ingredients.Normalize(req), ingredients.Normalize(stock)
	if rn == sn {
		return consumeExact
	}
	if ingredients.CategoryOf(rn) != ingredients.CategoryOf(sn) {
		return ""
	}
	if ingredients.IsCategoryHead(rn) || ingredients.IsCategoryHead(sn) {
		return consumeGeneric
	}
	return consumeSimilar
}

// consumeRank 批次在槽位内的排序档：默认可扣（未过期的精确/泛称）在前，过期批次排在后面，相近部位最后。
// 菜谱写的是具体部位（排骨）时精确优先于泛称（库存"猪肉"未必是排骨）；
// 菜谱写的是泛称（猪肉）时任何同类部位都完全满足，精确与泛称同档，严格按到期先后。
func consumeRank(b ConsumptionBatch, headRequest bool) int {
	rank := 0
	switch b.Kind {
	case consumeGeneric:
		if !headRequest {
			rank = 1
		}
	case consumeSimilar:
		rank = 4
	}
	if b.DaysLeft < 0 {
		rank += 2
	}
	return rank
}

// lessFIFO 先进先出：未过期的在前，再按到期日、买入时间
func lessFIFO(aDays, bDays int, aCreated, bCreated time.Time, aID, bID uint) bool {
	if aExpired, bExpired := aDays < 0, bDays < 0; aExpired != bExpired {
		return !aExpired
	}
	if aDays != bDays {
		return aDays < bDays
	}
	if !aCreated.Equal(bCreated) {
		return aCreated.Before(bCreated)
	}
	return aID < bID
}

// matchDishConsumption 纯函数：为菜谱的每项主料找出可扣减的库存批次。
// 常备配料（葱姜蒜）不参与；同名/真别名的重复写法合并为一个槽位；
// 每个批次只分配给一个槽位，避免一批被扣两次：精确匹配先分（同名只对应一个槽位，不存在争抢），
// 泛称与相近部位按先进先出轮流分（每轮每个槽位最多拿一批），不会让第一个槽位把同类批次全拿走。
// 没有任何候选批次的主料不出现在结果里。
func matchDishConsumption(dish models.Dish, batches []models.InventoryBatch, today time.Time) []ConsumptionSlot {
	type slot struct {
		name, amount string
		head         bool
		batches      []ConsumptionBatch
	}
	slots := make([]*slot, 0)
	seen := make(map[string]bool)
	for _, ing := range ParseIngredientList(dish.Ingredients) {
		if ingredients.IsStaple(ing.Name) {
			continue
		}
		key := ingredients.Normalize(ing.Name)
		if seen[key] {
			continue
		}
		seen[key] = true
		slots = append(slots, &slot{name: ing.Name, amount: ing.Amount, head: ingredients.IsCategoryHead(ing.Name)})
	}

	ordered := make([]models.InventoryBatch, len(batches))
	copy(ordered, batches)
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		return lessFIFO(daysLeftFor(a.ExpiryDate, today), daysLeftFor(b.ExpiryDate, today), a.CreatedAt, b.CreatedAt, a.ID, b.ID)
	})
	assigned := make(map[uint]bool, len(ordered))
	assign := func(s *slot, b models.InventoryBatch, kind string) {
		assigned[b.ID] = true
		s.batches = append(s.batches, ConsumptionBatch{
			BatchID:    b.ID,
			StockName:  b.ItemName,
			Quantity:   b.Quantity,
			ExpiryDate: b.ExpiryDate,
			DaysLeft:   daysLeftFor(b.ExpiryDate, today),
			Kind:       kind,
			createdAt:  b.CreatedAt,
		})
	}
	for _, s := range slots {
		for _, b := range ordered {
			if !assigned[b.ID] && consumeKind(s.name, b.ItemName) == consumeExact {
				assign(s, b, consumeExact)
			}
		}
	}
	for _, kind := range []string{consumeGeneric, consumeSimilar} {
		for progressed := true; progressed; {
			progressed = false
			for _, s := range slots {
				for _, b := range ordered {
					if !assigned[b.ID] && consumeKind(s.name, b.ItemName) == kind {
						assign(s, b, kind)
						progressed = true
						break
					}
				}
			}
		}
	}

	out := make([]ConsumptionSlot, 0, len(slots))
	for _, s := range slots {
		if len(s.batches) == 0 {
			continue
		}
		sort.SliceStable(s.batches, func(i, j int) bool {
			a, b := s.batches[i], s.batches[j]
			if ra, rb := consumeRank(a, s.head), consumeRank(b, s.head); ra != rb {
				return ra < rb
			}
			return lessFIFO(a.DaysLeft, b.DaysLeft, a.createdAt, b.createdAt, a.BatchID, b.BatchID)
		})
		for i := range s.batches {
			s.batches[i].RemainingHint = remainingAfterUse(s.batches[i].Quantity, s.amount)
		}
		var suggested uint
		if consumeRank(s.batches[0], s.head) <= 1 {
			suggested = s.batches[0].BatchID
		}
		out = append(out, ConsumptionSlot{
			RequestedName:    s.name,
			Amount:           s.amount,
			Batches:          s.batches,
			SuggestedBatchID: suggested,
		})
	}
	return out
}

// MatchDishConsumption 某道菜做完后可扣减的库存候选；菜品不存在返回 found=false，
// 数据库读取失败返回 error（不能伪装成"菜品不存在"或"冰箱里没有"）
func MatchDishConsumption(dishID uint) (*ConsumptionMatch, bool, error) {
	var dish models.Dish
	if err := database.DB.First(&dish, dishID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var batches []models.InventoryBatch
	if err := database.DB.Where("in_stock = ?", true).Find(&batches).Error; err != nil {
		return nil, false, err
	}
	return &ConsumptionMatch{DishID: dish.ID, Slots: matchDishConsumption(dish, batches, time.Now())}, true, nil
}

// unitAliases 同一单位的常见写法归一（只做写法归一，不做克/斤之类的换算）
var unitAliases = map[string]string{
	"g": "克", "克": "克",
	"kg": "千克", "千克": "千克", "公斤": "千克",
	"ml": "毫升", "毫升": "毫升",
	"l": "升", "升": "升",
	"斤": "斤",
}

func normalizeUnit(u string) string {
	u = strings.ToLower(strings.TrimSpace(u))
	if a, ok := unitAliases[u]; ok {
		return a
	}
	return u
}

// parseSimpleAmount 解析"数字+单位"形式的数量（如"6个""0.5斤"）；带"+"的组合或非数字开头返回 ok=false
func parseSimpleAmount(s string) (float64, string, bool) {
	s = strings.TrimSpace(s)
	if s == "" || strings.ContainsAny(s, "+＋") {
		return 0, "", false
	}
	m := amountPattern.FindStringSubmatch(s)
	if m == nil {
		return 0, "", false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, "", false
	}
	return n, strings.TrimSpace(m[2]), true
}

// remainingAfterUse 库存数量减去菜谱用量后的剩余量（沿用库存的单位写法）。
// 只在两边都是"数字+单位"且单位相同（同一单位的不同写法也算，如 g/克）时计算；
// 不做单位换算，剩余 <= 0 或无法计算时返回空串（交给用户自己选"用完"或手填）
func remainingAfterUse(stockQty, usedAmount string) string {
	have, haveUnit, ok := parseSimpleAmount(stockQty)
	if !ok {
		return ""
	}
	used, usedUnit, ok := parseSimpleAmount(usedAmount)
	if !ok || used <= 0 || normalizeUnit(haveUnit) != normalizeUnit(usedUnit) {
		return ""
	}
	left := math.Round((have-used)*100) / 100
	if left <= 0 {
		return ""
	}
	return formatAmountNumber(left) + haveUnit
}

// BatchRemaining 做完菜后某批次还剩多少（只改数量，不移出）
type BatchRemaining struct {
	BatchID  uint
	Quantity string
}

// ConsumeInventory 做完菜后更新冰箱：removeIDs 整批移出，remaining 改成剩余数量，
// 在同一事务里完成，任一步失败全部回滚。已不在库的批次不算错误，按实际影响行数返回。
func ConsumeInventory(removeIDs []uint, remaining []BatchRemaining) (removed, updated int64, err error) {
	err = database.DB.Transaction(func(tx *gorm.DB) error {
		if len(removeIDs) > 0 {
			res := tx.Where("id IN ?", removeIDs).Delete(&models.InventoryBatch{})
			if res.Error != nil {
				return res.Error
			}
			removed = res.RowsAffected
		}
		for _, r := range remaining {
			qty := strings.TrimSpace(r.Quantity)
			if qty == "" {
				return errors.New("剩余数量为空")
			}
			res := tx.Model(&models.InventoryBatch{}).Where("id = ?", r.BatchID).Update("quantity", qty)
			if res.Error != nil {
				return res.Error
			}
			updated += res.RowsAffected
		}
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	return removed, updated, nil
}

// ConsumeInventoryBatches 一次移除多个批次（单条 DELETE，原子生效），返回实际移除数。
// 部分批次已不在库（如另一台设备刚移出）不算错误，按实际移除数返回。
func ConsumeInventoryBatches(ids []uint) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	res := database.DB.Where("id IN ?", ids).Delete(&models.InventoryBatch{})
	return res.RowsAffected, res.Error
}
