package services

import (
	"encoding/json"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"sort"
	"strings"
)

// FridgeMatch 一道菜与当前冰箱存货的匹配结果
type FridgeMatch struct {
	Dish         models.Dish `json:"dish"`
	Matched      []string    `json:"matched"`
	Missing      []string    `json:"missing"`
	MatchedCount int         `json:"matched_count"`
	Coverage     int         `json:"coverage"` // 0-100，主要食材命中率
}

// ingredientAliases 常见食材别名组：同组名字在匹配时视为同一种食材
var ingredientAliases = [][]string{
	{"番茄", "西红柿"},
	{"土豆", "马铃薯", "洋芋"},
	{"洋葱", "圆葱"},
	{"包菜", "卷心菜", "圆白菜", "椰菜"},
	{"青椒", "菜椒", "甜椒", "柿子椒"},
	{"白菜", "大白菜"},
	{"虾仁", "虾"},
	{"香菜", "芫荽"},
	{"花菜", "菜花", "花椰菜"},
	{"四季豆", "豆角"},
	{"猪肉", "瘦肉"},
}

var ingredientCanonical = buildIngredientCanonical()

func buildIngredientCanonical() map[string]string {
	// 只做基础小写化，避免与 normalizeIngredientName 形成初始化循环
	lower := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	m := make(map[string]string)
	for _, group := range ingredientAliases {
		canonical := lower(group[0])
		for _, name := range group {
			m[lower(name)] = canonical
		}
	}
	return m
}

// normalizeIngredientName 归一化食材名：去空白、拉丁字母转小写、别名映射到规范名
func normalizeIngredientName(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if canonical, ok := ingredientCanonical[s]; ok {
		return canonical
	}
	return s
}

type fridgeIngredient struct {
	Name   string `json:"name"`
	Amount string `json:"amount"`
}

// parseDishIngredientNames 取菜品主要食材名（保持顺序、去重），调料不参与匹配
func parseDishIngredientNames(dish models.Dish) []string {
	var ings []fridgeIngredient
	if err := json.Unmarshal([]byte(dish.Ingredients), &ings); err != nil {
		return nil
	}
	seen := make(map[string]bool, len(ings))
	names := make([]string, 0, len(ings))
	for _, ing := range ings {
		name := strings.TrimSpace(ing.Name)
		if name == "" {
			continue
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// stapleIngredients 家家常备配料：不参与命中率计算，缺了也不影响"能做"
var stapleIngredients = map[string]bool{
	"葱": true, "小葱": true, "香葱": true, "大葱": true,
	"姜": true, "姜片": true, "姜丝": true, "姜末": true,
	"蒜": true, "大蒜": true, "蒜瓣": true, "蒜末": true,
}

// isStapleIngredient 是否常备配料（葱姜蒜一类）
func isStapleIngredient(name string) bool {
	return stapleIngredients[normalizeIngredientName(name)]
}

// matchDishesWithInventory 纯函数匹配：按主要食材命中率排序（命中率 → 命中数 → 收藏 → ID）
func matchDishesWithInventory(dishes []models.Dish, stockNames []string, limit int) []FridgeMatch {
	stock := make(map[string]bool, len(stockNames))
	for _, name := range stockNames {
		stock[normalizeIngredientName(name)] = true
	}

	matches := make([]FridgeMatch, 0)
	for _, dish := range dishes {
		ings := parseDishIngredientNames(dish)
		// 只统计非常备配料的主料，葱姜蒜不进分母
		mainIngs := make([]string, 0, len(ings))
		for _, ing := range ings {
			if !isStapleIngredient(ing) {
				mainIngs = append(mainIngs, ing)
			}
		}
		if len(mainIngs) == 0 {
			continue
		}
		// 初始化为空切片，避免全命中/全缺失时 JSON 序列化成 null
		matched := []string{}
		missing := []string{}
		seen := make(map[string]bool, len(mainIngs))
		for _, ing := range mainIngs {
			if seen[ing] {
				continue
			}
			seen[ing] = true
			if stock[normalizeIngredientName(ing)] {
				matched = append(matched, ing)
			} else {
				missing = append(missing, ing)
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
		})
	}

	sort.SliceStable(matches, func(i, j int) bool {
		a, b := matches[i], matches[j]
		if a.Coverage != b.Coverage {
			return a.Coverage > b.Coverage
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

// ListHomeInventoryItems 当前冰箱里的食材（in_stock），按最近更新排序
func ListHomeInventoryItems() []models.HomeInventory {
	items := []models.HomeInventory{}
	database.DB.Where("in_stock = ?", true).Order("updated_at DESC").Find(&items)
	return items
}

// AddHomeInventoryItem 放入冰箱：空名拒绝，存在则重新启用，不存在则创建
func AddHomeInventoryItem(itemName string) bool {
	itemName = strings.TrimSpace(itemName)
	if itemName == "" {
		return false
	}
	database.DB.Where("item_name = ?", itemName).
		Assign(models.HomeInventory{InStock: true}).
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

// MatchFridgeRecipes 用冰箱现有食材推荐能做的菜
func MatchFridgeRecipes(limit int) []FridgeMatch {
	if limit <= 0 || limit > 50 {
		limit = 12
	}
	var dishes []models.Dish
	database.DB.Where("enabled = ?", true).Find(&dishes)
	items := ListHomeInventoryItems()
	stockNames := make([]string, 0, len(items))
	for _, item := range items {
		stockNames = append(stockNames, item.ItemName)
	}
	matches := matchDishesWithInventory(dishes, stockNames, limit)
	if matches == nil {
		return []FridgeMatch{}
	}
	return matches
}
