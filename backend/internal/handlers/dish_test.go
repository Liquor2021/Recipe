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
	}
	for _, tt := range tests {
		if got := dishMatchesKeyword(tt.dish, tt.keyword); got != tt.want {
			t.Fatalf("dishMatchesKeyword(%s, %q) = %v, want %v (%s)", tt.dish.Name, tt.keyword, got, tt.want, tt.note)
		}
	}
}
