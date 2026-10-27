package services

import (
	"encoding/json"
	"ninimenu/internal/database"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"sort"
	"strings"
	"time"
)

// FridgeMatch 一道菜与当前冰箱存货的匹配结果
type FridgeMatch struct {
	Dish         models.Dish `json:"dish"`
	Matched      []string    `json:"matched"`
	Missing      []string    `json:"missing"`
	MatchedCount int         `json:"matched_count"`
	Coverage     int         `json:"coverage"` // 0-100，主要食材命中率
	UsingUrgent  []string    `json:"using_urgent"`
	// MatchedBatchIDs 命中食材对应的库存批次 ID（同品类多批次时为最早到期的那批），
	// 供"做完菜扣库存"按批次先进先出移除
	MatchedBatchIDs []uint `json:"matched_batch_ids"`
}

// StockItem 参与匹配的一批库存
type StockItem struct {
	BatchID   uint
	Name      string
	DaysLeft  int // 距过期的天数；999 表示未设置保质期
	CreatedAt time.Time
}

const noExpiryDays = 999

// ParseDishIngredientNames 取菜品主要食材名（保持顺序、去重），调料不参与匹配。
// 兼容两种存储格式：标准对象数组 [{"name":"鸡蛋","amount":"3个"}]，
// 以及旧数据/手工录入的字符串数组 ["鸡蛋","番茄"]（字符串即名字，无数量）。
func ParseDishIngredientNames(dish models.Dish) []string {
	var ings []struct {
		Name   string `json:"name"`
		Amount string `json:"amount"`
	}
	if err := json.Unmarshal([]byte(dish.Ingredients), &ings); err != nil {
		var names []string
		if err := json.Unmarshal([]byte(dish.Ingredients), &names); err != nil {
			return nil
		}
		return dedupeNames(names)
	}
	out := make([]string, 0, len(ings))
	for _, ing := range ings {
		out = append(out, ing.Name)
	}
	return dedupeNames(out)
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
		matchedBatchIDs := []uint{}
		for _, ing := range mainIngs {
			item, ok := stockByName[ingredients.CategoryOf(ing)]
			if !ok {
				missing = append(missing, ing)
				continue
			}
			matched = append(matched, ing)
			matchedBatchIDs = append(matchedBatchIDs, item.BatchID)
			if item.DaysLeft <= 4 {
				usingUrgent = append(usingUrgent, ing)
			}
		}
		if len(matched) == 0 {
			continue
		}
		matches = append(matches, FridgeMatch{
			Dish:            dish,
			Matched:         matched,
			Missing:         missing,
			MatchedCount:    len(matched),
			Coverage:        len(matched) * 100 / len(mainIngs),
			UsingUrgent:     usingUrgent,
			MatchedBatchIDs: matchedBatchIDs,
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

// CreateInventoryBatch 新增一批食材：空名拒绝；expiryDate 为空时按食材字典自动设默认保质期
func CreateInventoryBatch(itemName string, quantity string, expiryDate string) bool {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return false
	}
	quantity = strings.TrimSpace(quantity)
	if expiryDate == "" {
		expiry := time.Now().AddDate(0, 0, ingredients.ShelfLifeFor(itemName))
		expiryDate = expiry.Format("2006-01-02")
	}
	batch := models.InventoryBatch{
		ItemName:   itemName,
		InStock:    true,
		Quantity:   quantity,
		ExpiryDate: expiryDate,
	}
	database.DB.Create(&batch)
	return true
}

// UpdateInventoryBatch 更新某批次的质量字段（数量/保质期），返回是否找到
func UpdateInventoryBatch(id uint, quantity string, expiryDate string) bool {
	var batch models.InventoryBatch
	if err := database.DB.First(&batch, id).Error; err != nil {
		return false
	}
	batch.Quantity = strings.TrimSpace(quantity)
	batch.ExpiryDate = strings.TrimSpace(expiryDate)
	database.DB.Save(&batch)
	return true
}

// RemoveInventoryBatch 移出单批食材
func RemoveInventoryBatch(id uint) bool {
	res := database.DB.Delete(&models.InventoryBatch{}, id)
	return res.Error == nil && res.RowsAffected > 0
}

// RemoveInventoryItem 移出某食材的全部批次（购物清单"家中有"下线语义）
func RemoveInventoryItem(itemName string) {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return
	}
	database.DB.Where("item_name = ?", itemName).Delete(&models.InventoryBatch{})
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
	batches := ListInventoryBatches()
	stock := foldBatchesByCategory(batches, time.Now())
	matches := matchDishesWithInventory(dishes, stock, limit)
	if matches == nil {
		return []FridgeMatch{}
	}
	return matches
}
