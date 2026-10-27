package services

import (
	"fmt"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"path/filepath"
	"testing"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// setupSettingTestDB 为单测准备独立的临时文件 SQLite（内存库在连接池多连接下会各开一个空库，不可靠）
func setupSettingTestDB(t *testing.T) {
	t.Helper()
	old := database.DB
	db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "settings-test.db")), &gorm.Config{})
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	if err := db.AutoMigrate(&models.Setting{}); err != nil {
		t.Fatalf("迁移 Setting 表失败: %v", err)
	}
	database.DB = db
	t.Cleanup(func() {
		// 还原包级 database.DB，避免后续测试拿到这个已被关闭的临时连接
		database.DB = old
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close()
		}
	})
}

// seedSetting 写入一条设置；value 为空表示不写（模拟键缺失）
func seedSetting(t *testing.T, key, value string) {
	t.Helper()
	if value == "" {
		return
	}
	if err := database.DB.Create(&models.Setting{Key: key, Value: value}).Error; err != nil {
		t.Fatalf("写入设置 %s 失败: %v", key, err)
	}
}

func TestParseFamilyDislikeTokens(t *testing.T) {
	tokens := parseFamilyDislikeTokens(`[{"name":"爸爸","dislikes":["辣","香菜"]},{"name":"妈妈","dislikes":["海鲜"," 辣 "]}]`)
	if len(tokens) != 3 || !tokens["辣"] || !tokens["香菜"] || !tokens["海鲜"] {
		t.Fatalf("旧数组格式应汇总各成员忌口并去重去空白, got %v", tokens)
	}

	// 空数组 / 空串 / 纯空白 / 非法 JSON 都按"未配置"处理
	for _, raw := range []string{`[]`, "", "   ", `not-json{`, `[{"name":"爸爸"}]`} {
		if got := parseFamilyDislikeTokens(raw); got != nil {
			t.Fatalf("parseFamilyDislikeTokens(%q) = %v, want nil", raw, got)
		}
	}
}

// TestLoadFamilyDislikeConfigMode 依次覆盖：新配置缺失 mode（默认 avoid）、strict、
// avoid、非法值、family_members 非法 JSON、两键全缺。
func TestLoadFamilyDislikeConfigMode(t *testing.T) {
	members := `[{"name":"爸爸","dislikes":["辣"]}]`
	tests := []struct {
		note       string
		members    string
		mode       string
		wantStrict bool
		wantToken  bool // 是否应解析出忌口"辣"
	}{
		{"新配置缺失 mode，默认温和", members, "", false, true},
		{"显式 strict", members, "strict", true, true},
		{"显式 avoid", members, "avoid", false, true},
		{"非法 mode 值按 avoid 处理", members, "垃圾值", false, true},
		{"mode 带首尾空白仍识别", members, " strict ", true, true},
		{"family_members 非法 JSON，忌口为空但模式仍生效", `{"broken`, "strict", true, false},
		{"两键全缺", "", "", false, false},
	}
	for _, tt := range tests {
		setupSettingTestDB(t)
		seedSetting(t, "family_members", tt.members)
		seedSetting(t, "family_dislike_mode", tt.mode)

		cfg := loadFamilyDislikeConfig()
		if cfg.strict != tt.wantStrict {
			t.Fatalf("[%s] strict = %v, want %v", tt.note, cfg.strict, tt.wantStrict)
		}
		if tt.wantToken && !cfg.tokens["辣"] {
			t.Fatalf("[%s] 应解析出忌口\"辣\", got %v", tt.note, cfg.tokens)
		}
		if !tt.wantToken && len(cfg.tokens) != 0 {
			t.Fatalf("[%s] 忌口集应为空, got %v", tt.note, cfg.tokens)
		}
	}
}

func TestApplyDislikeMode(t *testing.T) {
	spicy := dishWithIngredients(1, "辣子鸡丁", false, `[{"name":"鸡腿","amount":"300g"}]`)
	spicy.Taste = "香辣"
	plain := dishWithIngredients(2, "清炒土豆丝", false, `[{"name":"马铃薯","amount":"1个"}]`)
	seafood := dishWithIngredients(3, "白灼虾", false, `[{"name":"虾仁","amount":"300g"}]`)
	dishes := []models.Dish{spicy, plain, seafood}

	// strict：命中忌口的菜被完全剔除，其余保持原顺序
	cfg := familyDislikeConfig{tokens: map[string]bool{"辣": true, "海鲜": true}, strict: true}
	got := applyDislikeMode(dishes, cfg)
	if len(got) != 1 || got[0].Name != "清炒土豆丝" {
		t.Fatalf("strict 应剔除命中忌口的菜, got %v", namesOf(got))
	}

	// strict 且全部命中：宁可返回空
	cfgAll := familyDislikeConfig{tokens: map[string]bool{"辣": true, "海鲜": true, "马铃薯": true}, strict: true}
	if got := applyDislikeMode(dishes, cfgAll); len(got) != 0 {
		t.Fatalf("全部命中时宁可返回空, got %v", namesOf(got))
	}

	// avoid：原样返回（降权交给调用方）
	cfgAvoid := familyDislikeConfig{tokens: map[string]bool{"辣": true}, strict: false}
	gotAvoid := applyDislikeMode(dishes, cfgAvoid)
	if len(gotAvoid) != len(dishes) {
		t.Fatalf("avoid 模式不应过滤, got %d want %d", len(gotAvoid), len(dishes))
	}

	// strict 但未配置忌口：不过滤
	cfgNoTokens := familyDislikeConfig{strict: true}
	if got := applyDislikeMode(dishes, cfgNoTokens); len(got) != len(dishes) {
		t.Fatalf("无忌口配置时 strict 不应过滤, got %d want %d", len(got), len(dishes))
	}

	// strict 过滤空池：安全返回空
	if got := applyDislikeMode(nil, cfg); len(got) != 0 {
		t.Fatalf("空池输入应返回空, got %v", namesOf(got))
	}
}

func namesOf(dishes []models.Dish) []string {
	out := make([]string, 0, len(dishes))
	for _, d := range dishes {
		out = append(out, fmt.Sprintf("%s(id=%d)", d.Name, d.ID))
	}
	return out
}
