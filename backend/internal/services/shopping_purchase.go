package services

import (
	"math"
	"ninimenu/internal/models"
	"strconv"
	"strings"

	"gorm.io/gorm"
)

// ShoppingCheck 的布尔值保留历史含义；数量快照用于区分已买和后来增加的需求。
func shoppingSnapshot(amount *string, marked bool, total string) *string {
	if amount != nil {
		return amount
	}
	if marked {
		return &total
	}
	return nil
}

func shoppingNumericAmount(amount string) (float64, string, bool) {
	m := scalableAmount.FindStringSubmatch(strings.TrimSpace(amount))
	if m == nil {
		return 0, "", false
	}
	n, err := strconv.ParseFloat(m[1], 64)
	return n, strings.TrimSpace(m[2]), err == nil && !math.IsInf(n, 0) && !math.IsNaN(n)
}

// 只减同单位的明确数量。文字量或单位不同无法推算，仍保留需求供用户核对。
func outstandingShoppingAmount(total string, covered *string) (string, bool) {
	total = strings.TrimSpace(total)
	if covered != nil {
		previous := strings.TrimSpace(*covered)
		if total == previous {
			return "", false
		}
		n, unit, ok := shoppingNumericAmount(total)
		old, oldUnit, oldOK := shoppingNumericAmount(previous)
		if ok && oldOK && unit == oldUnit {
			left := math.Round((n-old)*100) / 100
			if left <= 0 {
				return "", false
			}
			return formatAmountNumber(left) + unit, true
		}
	}
	if total == "" {
		total = "适量"
	}
	return total, true
}

func largerShoppingSnapshot(a, b *string) *string {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	n, unit, ok := shoppingNumericAmount(*a)
	m, otherUnit, otherOK := shoppingNumericAmount(*b)
	if ok && otherOK && unit == otherUnit && m > n {
		return b
	}
	return a
}

func purchasedShoppingAmount(total string, previous *string) *string {
	if previous != nil {
		n, unit, ok := shoppingNumericAmount(total)
		old, oldUnit, oldOK := shoppingNumericAmount(*previous)
		if ok && oldOK && unit == oldUnit && old > n {
			return previous
		}
	}
	return &total
}

func shoppingAmountNeedsReview(total string, covered *string) bool {
	if covered == nil {
		return false
	}
	if _, pending := outstandingShoppingAmount(total, covered); !pending {
		return false
	}
	_, unit, ok := shoppingNumericAmount(total)
	_, previousUnit, previousOK := shoppingNumericAmount(*covered)
	return !ok || !previousOK || unit != previousUnit
}

type shoppingDemand struct {
	row       models.ShoppingCheck
	sourceIDs []uint
	purchased *string
	stocked   *string
}

// 提前补料和后来同日同菜的购物行是同一份需求，已买数量只抵扣一份，不能
// 给同名的其他菜或另一餐也自动打勾。写操作通过 adoptShoppingDemands 把
// 冗余补料转交给确定的计划行，不能把相同采购复制成两份独立来源。
func shoppingDemands(rows []models.ShoppingCheck) []shoppingDemand {
	type key struct {
		date string
		dish uint
		name string
	}
	linked := make(map[key]int)
	demands := make([]shoppingDemand, 0, len(rows))
	appendRow := func(row models.ShoppingCheck) {
		stocked := shoppingSnapshot(row.StockedAmount, row.Stocked, row.ItemAmount)
		purchased := shoppingSnapshot(row.PurchasedAmount, row.Checked, row.ItemAmount)
		demands = append(demands, shoppingDemand{row: row, sourceIDs: []uint{row.ID}, purchased: largerShoppingSnapshot(purchased, stocked), stocked: stocked})
	}
	for _, row := range rows {
		if row.MealType == "extra" {
			continue
		}
		k := key{row.MealDate, row.DishID, row.ItemName}
		if _, exists := linked[k]; !exists {
			linked[k] = len(demands)
		}
		appendRow(row)
	}
	for _, row := range rows {
		if row.MealType != "extra" {
			continue
		}
		idx, exists := linked[key{row.MealDate, row.DishID, row.ItemName}]
		if !exists {
			appendRow(row)
			continue
		}
		d := &demands[idx]
		d.sourceIDs = append(d.sourceIDs, row.ID)
		stocked := shoppingSnapshot(row.StockedAmount, row.Stocked, row.ItemAmount)
		d.stocked = largerShoppingSnapshot(d.stocked, stocked)
		d.purchased = largerShoppingSnapshot(d.purchased, shoppingSnapshot(row.PurchasedAmount, row.Checked, row.ItemAmount))
		d.purchased = largerShoppingSnapshot(d.purchased, d.stocked)
	}
	return demands
}

// adoptShoppingDemands 必须位于调用方事务内。补料一旦被正式计划接续，采购
// 快照只由该计划保管；取消、改期、恢复或删除都不会把它再次分配给另一餐。
// 未匹配计划的独立补料不变。只读展示仍兼容尚未经历写操作的旧数据。
func adoptShoppingDemands(tx *gorm.DB, rows []models.ShoppingCheck) ([]shoppingDemand, error) {
	demands := shoppingDemands(rows)
	for i := range demands {
		d := &demands[i]
		if len(d.sourceIDs) < 2 {
			continue
		}
		if err := tx.Model(&models.ShoppingCheck{}).Where("id = ?", d.row.ID).Updates(map[string]any{
			"checked": d.purchased != nil, "purchased_amount": d.purchased,
			"stocked": d.stocked != nil, "stocked_amount": d.stocked,
		}).Error; err != nil {
			return nil, err
		}
		if err := tx.Unscoped().Where("id IN ? AND meal_type = ?", d.sourceIDs[1:], "extra").Delete(&models.ShoppingCheck{}).Error; err != nil {
			return nil, err
		}
		d.sourceIDs = d.sourceIDs[:1]
	}
	return demands, nil
}

// AdoptShoppingExtras 在计划建成或改变归属之前固化同一份采购的唯一归属。
// 由计划写操作的事务调用，采购转交和计划更新要么同时成功，要么同时回滚。
func AdoptShoppingExtras(tx *gorm.DB, dishID uint, date string) error {
	var rows []models.ShoppingCheck
	if err := tx.Where("dish_id = ? AND meal_date = ?", dishID, date).Order("id ASC").Find(&rows).Error; err != nil {
		return err
	}
	_, err := adoptShoppingDemands(tx, rows)
	return err
}
