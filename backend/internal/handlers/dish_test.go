package handlers

import (
	"ninimenu/internal/models"
	"testing"
)

func TestDishMatchesKeyword(t *testing.T) {
	tomatoEgg := models.Dish{ID: 1, Name: "番茄炒蛋", Ingredients: `[{"name":"番茄","amount":"2个"},{"name":"鸡蛋","amount":"3个"},{"name":"小葱","amount":"1根"}]`}
	potatoBeef := models.Dish{ID: 2, Name: "土豆烧牛腩", Ingredients: `[{"name":"马铃薯","amount":"1个"},{"name":"牛腩","amount":"500g"}]`}
	braisedPork := models.Dish{ID: 3, Name: "红烧排骨", Ingredients: `[{"name":"排骨","amount":"500g"}]`}

	tests := []struct {
		dish    models.Dish
		keyword string
		want    bool
		note    string
	}{
		{tomatoEgg, "番茄", true, "菜名命中"},
		{tomatoEgg, "鸡蛋", true, "食材命中"},
		{tomatoEgg, "小葱", true, "常备配料也算食材命中（搜索不是清冰箱推荐）"},
		{potatoBeef, "土豆", true, "食材是马铃薯，搜土豆经别名命中"},
		{potatoBeef, "牛肉", true, "牛腩包含牛肉子串"},
		{braisedPork, "肉", false, "排骨不含'肉'字，按字面匹配"},
		{braisedPork, "排骨", true, "食材命中"},
		{tomatoEgg, "牛肉", false, "番茄炒蛋没有牛肉"},
		{tomatoEgg, "", false, "空关键词不命中"},
		{tomatoEgg, "   ", false, "空白关键词不命中"},

		// —— 拼音路径（规格核心验收：茄按餐饮语境覆盖为 qie，缺了覆盖 fqcd 会全部失效）——
		{tomatoEgg, "fqcd", true, "菜名首字母拼音命中"},
		{tomatoEgg, "FQCD", true, "拼音大小写不敏感"},
		{tomatoEgg, "fanqie", true, "菜名全拼命中"},
		{tomatoEgg, "qcd", true, "全拼子串 Contains 命中（不必从头全等）"},
		{tomatoEgg, "fanqie蛋", true, "中英文混合输入：原有字面路径跑完后按剥出的字母走拼音路径"},
		{potatoBeef, "tudou", true, "菜名全拼子串命中（tudoushaoniunan）"},
		{potatoBeef, "tdsnn", true, "菜名首字母命中（土豆烧牛腩=tdsnn；原规格 tqn 系笔误，不存在 q 读音）"},
		{potatoBeef, "niunan", true, "全拼子串命中，验证 Contains 而非全等"},
		{tomatoEgg, "xyz", false, "无意义 ASCII 关键词不得误命中拼音或食材"},
		{tomatoEgg, "e", false, "单字母不走拼音路径（fanqiechaodan 含 e，否则全库误召回）"},
		{tomatoEgg, "a", false, "单字母不走拼音路径（fanqiechaodan 含 a）"},
		{tomatoEgg, "n", false, "单字母不走拼音路径（fanqiechaodan 含 n）"},
	}
	for _, tt := range tests {
		if got := dishMatchesKeyword(tt.dish, tt.keyword); got != tt.want {
			t.Fatalf("dishMatchesKeyword(%s, %q) = %v, want %v (%s)", tt.dish.Name, tt.keyword, got, tt.want, tt.note)
		}
	}
}
