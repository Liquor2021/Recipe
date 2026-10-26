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
}

type StockItem struct {
	Name     string
	DaysLeft int // 距过期的天数；999 表示未设置保质期
}

const noExpiryDays = 999

// ParseDishIngredientNames 取菜品主要食材名（保持顺序、去重），调料不参与匹配
func ParseDishIngredientNames(dish models.Dish) []string {
	var ings []struct {
		Name   string `json:"name"`
		Amount string `json:"amount"`
	}
	if err := json.Unmarshal([]byte(dish.Ingredients), &ings); err != nil {
		return nil
	}
	seen := make(map[string]bool, len(ings))
	names := make([]string, 0, len(ings))
	for _, ing := range ings {
		name := strings.TrimSpace(ing.Name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// daysLeftFor 计算某食材距过期的天数；未设置保质期返回 noExpiryDays
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

// matchDishesWithInventory 纯函数匹配：命中率优先，同命中率下优先用掉临期食材
func matchDishesWithInventory(dishes []models.Dish, stock []StockItem, limit int) []FridgeMatch {
	stockByName := make(map[string]StockItem, len(stock))
	for _, item := range stock {
		stockByName[ingredients.Normalize(item.Name)] = item
	}

	matches := make([]FridgeMatch, 0)
	for _, dish := range dishes {
		ings := ParseDishIngredientNames(dish)
		// 只统计非常备配料的主料，葱姜蒜不进分母
		mainIngs := make([]string, 0, len(ings))
		for _, ing := range ings {
			if !ingredients.IsStaple(ing) {
				mainIngs = append(mainIngs, ing)
			}
		}
		if len(mainIngs) == 0 {
			continue
		}
		// 初始化为空切片，避免全命中/全缺失时 JSON 序列化成 null
		matched := []string{}
		missing := []string{}
		usingUrgent := []string{}
		seen := make(map[string]bool, len(mainIngs))
		for _, ing := range mainIngs {
			if seen[ing] {
				continue
			}
			seen[ing] = true
			item, ok := stockByName[ingredients.Normalize(ing)]
			if !ok {
				missing = append(missing, ing)
				continue
			}
			matched = append(matched, ing)
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

// ListHomeInventoryItems 当前冰箱里的食材：临期的排前面（按到期日升序），未设置的按最近更新
func ListHomeInventoryItems() []models.HomeInventory {
	items := []models.HomeInventory{}
	database.DB.Where("in_stock = ?", true).Find(&items)
	today := time.Now()
	sort.SliceStable(items, func(i, j int) bool {
		di, dj := daysLeftFor(items[i].ExpiryDate, today), daysLeftFor(items[j].ExpiryDate, today)
		if (di == noExpiryDays) != (dj == noExpiryDays) {
			return di != noExpiryDays
		}
		if di != dj {
			return di < dj
		}
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
	return items
}

// AddHomeInventoryItem 放入冰箱：空名拒绝；expiryDate 为空时按食材字典自动设默认保质期
func AddHomeInventoryItem(itemName string, expiryDate string) bool {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return false
	}
	if expiryDate == "" {
		expiry := time.Now().AddDate(0, 0, ingredients.ShelfLifeFor(itemName))
		expiryDate = expiry.Format("2006-01-02")
	}
	database.DB.Where("item_name = ?", itemName).
		Assign(models.HomeInventory{InStock: true, ExpiryDate: expiryDate}).
		FirstOrCreate(&models.HomeInventory{ItemName: itemName})
	return true
}

// RemoveHomeInventoryItem 移出冰箱（硬删除，与购物清单「家中有」下线语义一致）
func RemoveHomeInventoryItem(itemName string) {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return
	}
	database.DB.Where("item_name = ?", itemName).Delete(&models.HomeInventory{})
}

// UrgentInventoryItems 临期食材（含今天过期），供首页提醒条使用
func UrgentInventoryItems() []models.HomeInventory {
	items := ListHomeInventoryItems()
	today := time.Now()
	urgent := []models.HomeInventory{}
	for _, item := range items {
		if daysLeftFor(item.ExpiryDate, today) <= 2 {
			urgent = append(urgent, item)
		}
	}
	return urgent
}

// MatchFridgeRecipes 用冰箱现有食材推荐能做的菜
func MatchFridgeRecipes(limit int) []FridgeMatch {
	if limit <= 0 || limit > 50 {
		limit = 12
	}
	var dishes []models.Dish
	database.DB.Where("enabled = ?", true).Find(&dishes)
	items := ListHomeInventoryItems()
	today := time.Now()
	stock := make([]StockItem, 0, len(items))
	for _, item := range items {
		stock = append(stock, StockItem{Name: item.ItemName, DaysLeft: daysLeftFor(item.ExpiryDate, today)})
	}
	matches := matchDishesWithInventory(dishes, stock, limit)
	if matches == nil {
		return []FridgeMatch{}
	}
	return matches
}
