package services

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"sort"
	"time"
)

var ErrShoppingDemandChanged = errors.New("shopping demand changed")

// 摘要覆盖展示范围和合并前的原始行。只比较总量会漏掉同量换菜、采购归属
// 或补料接续的变化，旧页面因此可能把另一份需求也标记为已买。
type shoppingDemandSnapshot struct {
	ID              uint
	MealDate        string
	MealType        string
	DishID          uint
	DishName        string
	ItemAmount      string
	BaseAmount      string
	Checked         bool
	Stocked         bool
	PurchasedAmount *string
	StockedAmount   *string
	UpdatedAt       string
}

func shoppingDemandVersions(dates []string, rows []models.ShoppingCheck) map[string]string {
	sortedDates := append([]string(nil), dates...)
	sort.Strings(sortedDates)
	dateSet := make(map[string]bool, len(sortedDates))
	for _, date := range sortedDates {
		dateSet[date] = true
	}
	byName := make(map[string][]shoppingDemandSnapshot)
	for _, row := range rows {
		if row.DeletedAt.Valid || !dateSet[row.MealDate] || ingredients.IsTapWater(row.ItemName) {
			continue
		}
		byName[row.ItemName] = append(byName[row.ItemName], shoppingDemandSnapshot{
			ID: row.ID, MealDate: row.MealDate, MealType: row.MealType,
			DishID: row.DishID, DishName: row.DishName, ItemAmount: row.ItemAmount, BaseAmount: row.BaseAmount,
			Checked: row.Checked, Stocked: row.Stocked,
			PurchasedAmount: row.PurchasedAmount, StockedAmount: row.StockedAmount,
			UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339Nano),
		})
	}
	versions := make(map[string]string, len(byName))
	for name, snapshots := range byName {
		sort.Slice(snapshots, func(i, j int) bool { return snapshots[i].ID < snapshots[j].ID })
		// 仅包含固定类型的字符串、整数、布尔值和可空字符串，序列化不会失败。
		data, _ := json.Marshal(struct {
			Schema string
			Name   string
			Dates  []string
			Rows   []shoppingDemandSnapshot
		}{"shopping-demand-v1", name, sortedDates, snapshots})
		hash := sha256.Sum256(data)
		versions[name] = hex.EncodeToString(hash[:])
	}
	return versions
}
