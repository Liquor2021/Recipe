package ingredients

import "testing"

func TestNormalizeAlias(t *testing.T) {
	tests := []struct{ in, want string }{
		{" 番茄 ", "番茄"},
		{"西红柿", "番茄"},
		{"马铃薯", "土豆"},
		{"洋芋", "土豆"},
		{"Bacon", "bacon"},
		{"小白菜", "小白菜"}, // "白菜"别名只覆盖自身组，不影响小白菜
		{"虾仁", "虾仁"},   // 自身就是规范名
		{"虾", "虾仁"},    // 别名指回规范名
	}
	for _, tt := range tests {
		if got := Normalize(tt.in); got != tt.want {
			t.Fatalf("Normalize(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestIsStaple(t *testing.T) {
	for _, name := range []string{"小葱", "姜", "蒜", " 大蒜 ", "蒜末"} {
		if !IsStaple(name) {
			t.Fatalf("IsStaple(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"番茄", "鸡蛋", "五花肉", "小白菜"} {
		if IsStaple(name) {
			t.Fatalf("IsStaple(%q) = true, want false", name)
		}
	}
}

func TestIsCategoryHead(t *testing.T) {
	for _, name := range []string{"猪肉", " 牛肉 ", "鸡肉"} {
		if !IsCategoryHead(name) {
			t.Fatalf("IsCategoryHead(%q) = false, want true", name)
		}
	}
	// 具体部位与不在大类表里的食材都不是泛称
	for _, name := range []string{"排骨", "五花肉", "牛腩", "鸡翅", "番茄", ""} {
		if IsCategoryHead(name) {
			t.Fatalf("IsCategoryHead(%q) = true, want false", name)
		}
	}
}

func TestIsTapWater(t *testing.T) {
	for _, name := range []string{"清水", " 热水 ", "温水", "开水", "凉白开", "水"} {
		if !IsTapWater(name) {
			t.Fatalf("IsTapWater(%q) = false, want true", name)
		}
	}
	// 要买的饮品/食材不算
	for _, name := range []string{"矿泉水", "椰子水", "水豆腐", "水淀粉", "番茄"} {
		if IsTapWater(name) {
			t.Fatalf("IsTapWater(%q) = true, want false", name)
		}
	}
}

func TestShelfLifeFor(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"鸡蛋", 30},
		{"西红柿", 7}, // 别名也能查到保质期
		{"豆腐", 3},
		{"火腿肠", 90},
		{"山姆买的神秘菜", 5}, // 未收录食材兜底 5 天
	}
	for _, tt := range tests {
		if got := ShelfLifeFor(tt.in); got != tt.want {
			t.Fatalf("ShelfLifeFor(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestAliasGroupsAreConsistent(t *testing.T) {
	// 每个组的所有别名必须归一到组内第一个（防止字典加错行静默失效）
	for _, group := range AliasGroups {
		want := Normalize(group[0])
		for _, name := range group {
			if got := Normalize(name); got != want {
				t.Fatalf("alias group %v broken: Normalize(%q) = %q, want %q", group, name, got, want)
			}
		}
	}
	// 常备配料不能同时出现在别名组（避免归一化把它变成非常备名）
	for name := range Staples {
		if !Staples[Normalize(name)] {
			t.Fatalf("staple %q not stable after normalization", name)
		}
	}
}
