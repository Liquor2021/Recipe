package search

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"ninimenu/internal/models"
)

func TestConvert(t *testing.T) {
	tests := []struct {
		name     string
		full     string
		initials string
		note     string
	}{
		{"番茄炒蛋", "fanqiechaodan", "fqcd", "核心验收：茄按餐饮语境覆盖为 qie（字典默认 jia）"},
		{"土豆烧牛腩", "tudoushaoniunan", "tdsnn", "全拼与首字母"},
		{"重庆火锅", "zhongqinghuoguo", "zqhg", "未覆盖多音字按字典默认读音（重→zhong），搜 cq/chongqing 不中，遇到再补覆盖表"},
		{"长大红烧肉", "zhangdahongshaorou", "zdhsr", "未覆盖多音字按字典默认读音（长→zhang）"},
		{"麻辣香锅（微辣）", "malaxiangguoweila", "mlxgwl", "全角标点丢弃"},
		{"可乐鸡翅2份", "kelejichifen", "kljcf", "数字丢弃"},
		{"Pizza披萨", "pizzapisa", "pizzaps", "菜名里的 ASCII 字母保留（转小写）"},
		{"", "", "", "空菜名转出空串"},
	}
	for _, tt := range tests {
		got := Convert(tt.name)
		if got.Full != tt.full || got.Initials != tt.initials {
			t.Fatalf("Convert(%q) = (%q, %q), want (%q, %q) (%s)", tt.name, got.Full, got.Initials, tt.full, tt.initials, tt.note)
		}
	}
}

func TestPinyinMatch(t *testing.T) {
	resetIndex()
	// 索引为空时走"现算现查"兜底，也应能正确匹配
	if !PinyinMatch("番茄炒蛋", "fqcd") || !PinyinMatch("番茄炒蛋", "FQCD") {
		t.Fatalf("番茄炒蛋 应能被 fqcd/FQCD 兜底命中（茄覆盖回归）")
	}
	if PinyinMatch("番茄炒蛋", "") || PinyinMatch("", "fqcd") {
		t.Fatalf("空菜名或空关键词不应命中")
	}
}

// versionOf 按旧语义从菜品列表的 max(updated_at) 推版本戳（仅测试用；
// 生产调用方 dish.go 用无条件 SELECT MAX(updated_at) 计算，见 Refresh 注释）
func versionOf(dishes []models.Dish) string {
	var maxAt time.Time
	for i := range dishes {
		if dishes[i].UpdatedAt.After(maxAt) {
			maxAt = dishes[i].UpdatedAt
		}
	}
	return maxAt.UTC().Format(time.RFC3339Nano)
}

func TestRefreshVersionCache(t *testing.T) {
	resetIndex()

	t1 := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	t2 := t1.Add(time.Hour)
	dishes := []models.Dish{
		{ID: 1, Name: "番茄炒蛋", UpdatedAt: t1},
		{ID: 2, Name: "土豆烧牛腩", UpdatedAt: t2},
	}

	Refresh(versionOf(dishes), dishes)
	mu.RLock()
	v1, idx1 := version, byName
	mu.RUnlock()
	if _, ok := idx1["番茄炒蛋"]; !ok {
		t.Fatalf("首次 Refresh 后索引应有番茄炒蛋")
	}

	// 版本未变：复用同一份索引（map 指针不变），不重建
	Refresh(versionOf(dishes), dishes)
	mu.RLock()
	v2, idx2 := version, byName
	mu.RUnlock()
	if v1 != v2 || fmt.Sprintf("%p", idx1) != fmt.Sprintf("%p", idx2) {
		t.Fatalf("版本未变应复用索引，got version %q -> %q, map %p -> %p", v1, v2, idx1, idx2)
	}
	if !PinyinMatch("番茄炒蛋", "fqcd") || !PinyinMatch("土豆烧牛腩", "tdsnn") {
		t.Fatalf("缓存索引下拼音匹配失败")
	}

	// 版本变了（版本戳推高）：全量重建为新索引
	changed := append([]models.Dish(nil), dishes...)
	changed[0].UpdatedAt = t2.Add(time.Hour)
	Refresh(versionOf(changed), changed)
	mu.RLock()
	v3, idx3 := version, byName
	mu.RUnlock()
	if v3 == v2 || fmt.Sprintf("%p", idx2) == fmt.Sprintf("%p", idx3) {
		t.Fatalf("版本变化应全量重建，got version %q -> %q, map %p -> %p", v2, v3, idx2, idx3)
	}

	// 空列表：版本戳退回零值时间，索引清空
	Refresh(versionOf(nil), nil)
	mu.RLock()
	v4, idx4 := version, byName
	mu.RUnlock()
	if len(idx4) != 0 || v4 == v3 {
		t.Fatalf("空列表应重建为空索引，got len=%d version %q -> %q", len(idx4), v3, v4)
	}
}

func TestRefreshConcurrent(t *testing.T) {
	resetIndex()

	base := []models.Dish{
		{ID: 1, Name: "番茄炒蛋", UpdatedAt: time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)},
		{ID: 2, Name: "土豆烧牛腩", UpdatedAt: time.Date(2026, 10, 28, 13, 0, 0, 0, time.UTC)},
	}
	updated := append([]models.Dish(nil), base...)
	updated[0].UpdatedAt = base[1].UpdatedAt.Add(time.Hour)

	// 并发刷新两个版本 + 并发读，靠 -race 验证 RWMutex 保护（需 go test -race 跑本包）
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			for n := 0; n < 100; n++ {
				Refresh(versionOf(base), base)
			}
		}()
		go func() {
			defer wg.Done()
			for n := 0; n < 100; n++ {
				Refresh(versionOf(updated), updated)
			}
		}()
		go func() {
			defer wg.Done()
			for n := 0; n < 100; n++ {
				PinyinMatch("番茄炒蛋", "fqcd")
				PinyinMatch("土豆烧牛腩", "niunan")
			}
		}()
	}
	wg.Wait()

	Refresh(versionOf(base), base) // 收尾落回确定状态，最终一致
	if !PinyinMatch("番茄炒蛋", "fqcd") || !PinyinMatch("土豆烧牛腩", "niunan") {
		t.Fatalf("并发刷新后拼音匹配应正常")
	}
}

// BenchmarkRefresh632 印证注释里"全量重建 632 道菜毫秒级"的取舍：按当前菜单规模压测重建耗时
func BenchmarkRefresh632(b *testing.B) {
	resetIndex()
	dishes := make([]models.Dish, 0, 632)
	at := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	prefixes := []string{"红烧", "清蒸", "爆炒", "香煎", "麻辣", "蒜蓉", "茄汁", "糖醋", "白灼", "酱焖"}
	mains := []string{"排骨", "牛腩", "鸡翅", "土豆", "茄子", "豆腐", "鱼片", "虾仁", "西兰花", "蛋"}
	for i := 0; i < 632; i++ {
		dishes = append(dishes, models.Dish{
			ID:        uint(i + 1),
			Name:      fmt.Sprintf("%s%s%d号", prefixes[i%len(prefixes)], mains[(i/len(prefixes))%len(mains)], i),
			UpdatedAt: at,
		})
	}
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		resetIndex() // 每轮强制全量重建
		Refresh(versionOf(dishes), dishes)
	}
}

// resetIndex 清空包级缓存，避免用例间相互依赖
func resetIndex() {
	mu.Lock()
	defer mu.Unlock()
	version = ""
	byName = nil
}
