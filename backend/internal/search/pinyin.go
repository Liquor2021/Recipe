// Package search 提供菜品名拼音检索：把菜名转成全拼与首字母缩写，
// 让用户直接输入拼音（fqcd、fanqie、tudou）也能搜到中文菜名。
// 纯进程内实现，无持久化。
package search

import (
	"strings"
	"sync"
	"unicode"

	"github.com/mozillazg/go-pinyin"

	"ninimenu/internal/models"
)

// forcedReadings 多音字餐饮语境读音覆盖表（字 → 强制读音）。
// go-pinyin 非多音字模式取字典第一个读音，但个别字的字典首读与餐饮常用读音不一致：
// "茄"字典首读 jia（雪茄），番茄/茄子在餐饮语境都读 qie，不覆盖则"fqcd/fanqie"这类
// 搜索全部失效。后续遇到其他字再补进这张表即可。
// 取舍：只纠已确认的常用字，不为生僻读音引入多音字变体组合（避免误命中和实现复杂度）。
var forcedReadings = map[string]string{
	"茄": "qie",
}

// pinyinArgs 无声调小写拼音（go-pinyin 默认 Normal 风格）。Args 按值传入
// SinglePinyin，包级共享只读，并发安全。
var pinyinArgs = pinyin.NewArgs()

// Entry 一条菜名的拼音检索串（只含小写 a-z，可用 Contains 做子串匹配）
type Entry struct {
	Full     string // 全拼，如 番茄炒蛋 → fanqiechaodan
	Initials string // 首字母，如 番茄炒蛋 → fqcd
}

// Convert 把菜名转成（全拼, 首字母）。规则：
//   - 汉字转无声调拼音；多音字取字典默认读音，餐饮语境常用读音走 forcedReadings 覆盖；
//   - 菜名里的 ASCII 字母（英文/品牌词，如"Pizza披萨"）按原样保留（转小写）；
//   - 标点、数字、空白等其余字符丢弃，保证两个串都是纯 [a-z]，Contains 语义可预期
//     （调用方的关键词同样剥成纯字母，见 handlers.dishMatchesKeyword）。
func Convert(name string) Entry {
	var full, initials strings.Builder
	for _, r := range name {
		if rep, ok := forcedReadings[string(r)]; ok {
			full.WriteString(rep)
			initials.WriteByte(rep[0])
			continue
		}
		py := pinyin.SinglePinyin(r, pinyinArgs)
		if len(py) > 0 && py[0] != "" {
			full.WriteString(py[0])
			initials.WriteByte(py[0][0])
			continue
		}
		// 非汉字：仅保留 ASCII 字母
		if lr := unicode.ToLower(r); lr >= 'a' && lr <= 'z' {
			full.WriteRune(lr)
			initials.WriteRune(lr)
		}
	}
	return Entry{Full: full.String(), Initials: initials.String()}
}

// 索引缓存：键为菜品全集的版本戳 = max(updated_at)。
// 任何一次菜品写入都由 GORM 自动推高 updated_at，从而推高版本戳：
// 版本未变 → 数据未变 → 直接复用；版本变了 → 全量重建。
// 取舍：全量重建是纯内存拼音查表，632 道菜毫秒级，相比逐菜失效/增量维护的实现
// 与正确性风险，全量重建更简单可靠；写锁仅在版本变化后的首次搜索出现，不构成热点。
// 已删除菜品若恰好不是 updated_at 最新的那条，版本戳不变，其索引条目会残留到下次
// 重建——但条目只会被"遍历现存菜品"的调用方按菜名查询，残留条目永远不会被命中，无副作用。
// 极端时钟回拨可能让写入不推高版本戳导致漏刷新，重启进程即自愈（缓存本来就在进程内）。
var (
	mu      sync.RWMutex
	version string           // 当前索引对应的版本戳（max updated_at 的 RFC3339Nano 形式）
	byName  map[string]Entry // 菜名 → 拼音（同名菜共用同一条目）
)

// Refresh 用候选菜品刷新拼音索引：版本戳 v 未变直接复用，变了才全量重建。
// GetDishes 的搜索分支在内存过滤前调用一次；其他调用方（如单测）不调也能用，
// PinyinMatch 对未缓存的菜名会现算现查（不写缓存）。
//
// v 必须取自"无条件筛选"的全局查询（如 SELECT MAX(updated_at) FROM dishes），
// 不能用传入子集的 max(updated_at) 推算：主列表搜索常带 category/taste 筛选，
// 子集版本戳随筛选组合漂移，每次切换筛选再搜索都会误判"版本已变"而触发
// 全量重建并拿写锁，"版本未变直接复用"的缓存设计会在常用路径上被击穿。
// dishes 允许是筛选后的子集：未入索引的菜名由 PinyinMatch 现算兜底，正确性不受影响。
func Refresh(v string, dishes []models.Dish) {
	mu.RLock()
	if v == version {
		mu.RUnlock()
		return
	}
	mu.RUnlock()

	// 双重检查：拿到写锁后再验一次版本，避免并发 Refresh 重复重建
	mu.Lock()
	defer mu.Unlock()
	if v == version {
		return
	}
	idx := make(map[string]Entry, len(dishes))
	for i := range dishes {
		name := dishes[i].Name
		if name == "" {
			continue
		}
		if _, ok := idx[name]; ok {
			continue // 同名菜只算一次
		}
		idx[name] = Convert(name)
	}
	version = v
	byName = idx
}

// PinyinMatch 报告菜名的拼音（全拼或首字母，大小写不敏感）是否包含 kw。
// kw 应为纯 a-z 字母（调用方已剥掉非 ASCII 字母），这里仅做小写兜底。
func PinyinMatch(name, kw string) bool {
	kw = strings.ToLower(strings.TrimSpace(kw))
	if kw == "" || name == "" {
		return false
	}

	mu.RLock()
	entry, ok := byName[name]
	mu.RUnlock()
	if !ok {
		// 兜底：索引未刷新（如单测直调、或调用方没走 Refresh）时现算，单次微秒级
		entry = Convert(name)
	}
	return strings.Contains(entry.Full, kw) || strings.Contains(entry.Initials, kw)
}
