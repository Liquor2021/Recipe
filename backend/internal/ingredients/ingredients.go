// Package ingredients 是全项目统一的食材知识库，分两层语义：
//
//   - 真别名（AliasGroups/Normalize）：同一食材的不同叫法（番茄=西红柿），
//     用于冰箱匹配去重、食材搜索精确命中；
//   - 部位大类（CategoryGroups/CategoryOf）：同属一类但不是同一食材
//     （瘦肉/五花肉/排骨都是猪肉，但做法、价格、口感不同），
//     用于家庭忌口（不吃猪肉应命中所有猪肉形态）、保质期兜底、搜索的宽匹配。
//
// 常备配料（Staples）与默认保质期（DefaultShelfLifeDays）也在这里统一维护。
package ingredients

import "strings"

// AliasGroups 真别名组：同组名字视为同一种食材，组内第一个为规范名
var AliasGroups = [][]string{
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
	{"菜籽油", "食用油"},
}

// CategoryGroups 部位大类组：同属一类食材但不是同一种（组内第一个为大类名）。
// 忌口匹配与保质期兜底走这里；冰箱匹配的去重与命中也按大类，避免"一块猪肉
// 同时填满瘦肉和五花肉两个槽位"造成的覆盖率虚增。
var CategoryGroups = [][]string{
	{"猪肉", "瘦肉", "五花肉", "肉末", "排骨"},
	{"牛肉", "牛腩"},
	{"鸡肉", "鸡腿", "鸡翅", "鸡块"},
}

// Staples 家家常备配料：清冰箱推荐时不参与命中率计算，缺了也不影响"能做"
var Staples = map[string]bool{
	"葱": true, "小葱": true, "香葱": true, "大葱": true,
	"葱花": true, "葱段": true, "葱丝": true, "葱末": true,
	"姜": true, "姜片": true, "姜丝": true, "姜末": true,
	"蒜": true, "大蒜": true, "蒜瓣": true, "蒜末": true,
}

// DefaultShelfLifeDays 食材名（或大类名）→ 默认保质期天数。
// 键按大类归并维护（瘦肉/五花肉等形态统一落到大类"猪肉"），
// 查找顺序见 ShelfLifeFor。
var DefaultShelfLifeDays = map[string]int{
	"番茄": 7, "土豆": 30, "洋葱": 30, "包菜": 10, "青椒": 7, "白菜": 10,
	"胡萝卜": 21, "白萝卜": 21, "黄瓜": 7, "茄子": 7, "芹菜": 7, "生菜": 5,
	"菠菜": 3, "韭菜": 3, "豆芽": 2, "冬瓜": 14, "南瓜": 30, "玉米": 7,
	"西兰花": 7, "香菇": 7, "金针菇": 5, "蘑菇": 5, "莲藕": 7, "山药": 14,
	"豆腐": 3, "豆干": 5, "鸡蛋": 30, "牛奶": 7, "酸奶": 14,
	"猪肉": 3, "牛肉": 3, "羊肉": 3, "鸡肉": 2,
	"虾仁": 2, "虾": 2, "鱼": 2, "带鱼": 2, "鱿鱼": 2, "火腿肠": 90,
	"培根": 7, "面条": 7, "米粉": 7, "面包": 4, "玉米淀粉": 365,
}

// canonical 真别名 → 规范名索引（包初始化时构建）
var canonical = buildIndex(AliasGroups)

// categoryIndex 大类 → 组内成员索引（含自身），用于 CategoryOf
var categoryIndex = buildIndex(CategoryGroups)

// buildIndex 为组内每个名字建立指向组首名的索引。
// 只做基础小写化，避免与导出函数形成初始化循环（映射会静默失效）。
func buildIndex(groups [][]string) map[string]string {
	lower := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	m := make(map[string]string)
	for _, group := range groups {
		head := lower(group[0])
		for _, name := range group {
			m[lower(name)] = head
		}
	}
	return m
}

// Normalize 真别名归一：去空白、拉丁字母转小写、别名映射到规范名
func Normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if c, ok := canonical[s]; ok {
		return c
	}
	return s
}

// CategoryOf 部位大类归一：先做真别名归一，再映射到大类；不属于任何大类时返回真别名归一名
func CategoryOf(s string) string {
	n := Normalize(s)
	if c, ok := categoryIndex[n]; ok {
		return c
	}
	return n
}

// IsStaple 是否常备配料（葱姜蒜及其切配形态）
func IsStaple(name string) bool {
	return Staples[Normalize(name)]
}

// ShelfLifeFor 食材默认保质期天数：先查原始名，再查大类名，都没有按未收录生鲜 5 天兜底
func ShelfLifeFor(name string) int {
	if days, ok := DefaultShelfLifeDays[Normalize(name)]; ok {
		return days
	}
	if days, ok := DefaultShelfLifeDays[CategoryOf(name)]; ok {
		return days
	}
	return 5
}
