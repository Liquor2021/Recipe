// Package ingredients 是全项目统一的食材知识库：
// 别名归一（冰箱匹配 / 食材搜索共用）、常备配料（清冰箱推荐忽略）、默认保质期（临期管理兜底）。
// 后续任何食材相关功能（替换建议、营养估算）都应基于此包，避免多套逻辑漂移。
package ingredients

import "strings"

// AliasGroups 常见食材别名组：同组名字视为同一种食材，组内第一个为规范名
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
	{"猪肉", "瘦肉", "五花肉", "肉末", "排骨"},
	{"牛肉", "牛腩"},
	{"鸡肉", "鸡腿", "鸡翅", "鸡块"},
	{"菜籽油", "食用油"},
}

// Staples 家家常备配料：清冰箱推荐时不参与命中率计算，缺了也不影响"能做"
var Staples = map[string]bool{
	"葱": true, "小葱": true, "香葱": true, "大葱": true,
	"姜": true, "姜片": true, "姜丝": true, "姜末": true,
	"蒜": true, "大蒜": true, "蒜瓣": true, "蒜末": true,
}

// DefaultShelfLifeDays 规范食材名 → 默认保质期天数（常温/冷藏的粗略混合值，供临期管理兜底）
var DefaultShelfLifeDays = map[string]int{
	"番茄": 7, "土豆": 30, "洋葱": 30, "包菜": 10, "青椒": 7, "白菜": 10,
	"胡萝卜": 21, "白萝卜": 21, "黄瓜": 7, "茄子": 7, "芹菜": 7, "生菜": 5,
	"菠菜": 3, "韭菜": 3, "豆芽": 2, "冬瓜": 14, "南瓜": 30, "玉米": 7,
	"西兰花": 7, "香菇": 7, "金针菇": 5, "蘑菇": 5, "莲藕": 7, "山药": 14,
	"豆腐": 3, "豆干": 5, "鸡蛋": 30, "牛奶": 7, "酸奶": 14,
	"猪肉": 3, "瘦肉": 3, "五花肉": 3, "肉末": 2, "排骨": 3, "牛腩": 3,
	"牛肉": 3, "羊肉": 3, "鸡肉": 2, "鸡腿": 2, "鸡翅": 3, "鸭肉": 3,
	"虾仁": 2, "虾": 2, "鱼": 2, "带鱼": 2, "鱿鱼": 2, "火腿肠": 90,
	"培根": 7, "面条": 7, "米粉": 7, "面包": 4, "玉米淀粉": 365,
}

// canonical 别名 → 规范名索引（包初始化时构建）
var canonical = buildCanonical()

func buildCanonical() map[string]string {
	// 只做基础小写化，避免与 Normalize 形成初始化循环（别名映射会静默失效）
	lower := func(s string) string { return strings.ToLower(strings.TrimSpace(s)) }
	m := make(map[string]string)
	for _, group := range AliasGroups {
		canonicalName := lower(group[0])
		for _, name := range group {
			m[lower(name)] = canonicalName
		}
	}
	return m
}

// Normalize 归一化食材名：去空白、拉丁字母转小写、别名映射到规范名
func Normalize(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if c, ok := canonical[s]; ok {
		return c
	}
	return s
}

// IsStaple 是否常备配料（葱姜蒜一类）
func IsStaple(name string) bool {
	return Staples[Normalize(name)]
}

// ShelfLifeFor 食材默认保质期天数；不在字典里的生鲜按 5 天兜底
func ShelfLifeFor(name string) int {
	if days, ok := DefaultShelfLifeDays[Normalize(name)]; ok {
		return days
	}
	return 5
}
