package handlers

import (
	"encoding/json"
	"net/url"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"
)

func settingValue(t *testing.T, key string) (string, bool) {
	t.Helper()
	var s models.Setting
	if err := database.DB.Where("`key` = ?", key).First(&s).Error; err != nil {
		return "", false
	}
	return s.Value, true
}

func TestUpdateSettingsCanClearAndCreate(t *testing.T) {
	setupHandlerTestDB(t, &models.Setting{})
	database.DB.Create(&models.Setting{Key: "family_members", Value: `[{"name":"妈妈","dislikes":["辣"]}]`})
	database.DB.Create(&models.Setting{Key: "admin_password", Value: "keep"})

	w := serveJSON(t, UpdateSettings, "PUT", "/api/settings", map[string]any{"settings": map[string]string{
		"family_members":      "",       // 已有的键清空成空串
		"family_dislike_mode": "strict", // 不存在的键新建
		"admin_password":      "hacked", // 受保护的键忽略
	}})
	if w.Code != 200 {
		t.Fatalf("status = %d %s", w.Code, w.Body.String())
	}
	if v, ok := settingValue(t, "family_members"); !ok || v != "" {
		t.Fatalf("设置应能被清空为空串, got %q ok=%v", v, ok)
	}
	if v, _ := settingValue(t, "family_dislike_mode"); v != "strict" {
		t.Fatalf("不存在的键应新建, got %q", v)
	}
	if v, _ := settingValue(t, "admin_password"); v != "keep" {
		t.Fatalf("admin_password 不应被接口改写, got %q", v)
	}
}

type dishListResponse struct {
	Code int `json:"code"`
	Data struct {
		Total int64 `json:"total"`
		Items []struct {
			ID   uint   `json:"id"`
			Name string `json:"name"`
		} `json:"items"`
	} `json:"data"`
}

func listDishes(t *testing.T, query string) dishListResponse {
	t.Helper()
	w := serveJSON(t, GetDishes, "GET", "/api/dishes?"+query, nil)
	var resp dishListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || w.Code != 200 {
		t.Fatalf("GetDishes(%s) status=%d err=%v body=%s", query, w.Code, err, w.Body.String())
	}
	return resp
}

func TestGetDishesExcludeDisliked(t *testing.T) {
	setupHandlerTestDB(t, &models.Dish{}, &models.Setting{})
	database.DB.Create(&models.Dish{Name: "辣子鸡", Taste: "香辣", Enabled: true, SortOrder: 1})
	database.DB.Create(&models.Dish{Name: "清炒时蔬", Taste: "清淡", Enabled: true, SortOrder: 2})
	database.DB.Create(&models.Dish{Name: "麻辣鸡丝", Taste: "麻辣", Enabled: true, SortOrder: 3})
	database.DB.Create(&models.Setting{Key: "family_members", Value: `[{"name":"妈妈","dislikes":["辣"]}]`})

	// avoid 模式：exclude_disliked 不过滤（strict 才剔除）
	if r := listDishes(t, "enabled=true&exclude_disliked=1"); r.Data.Total != 3 {
		t.Fatalf("avoid 模式不应过滤, total=%d", r.Data.Total)
	}

	database.DB.Create(&models.Setting{Key: "family_dislike_mode", Value: "strict"})
	r := listDishes(t, "enabled=true&sort=sort_order&order=asc&pageSize=1&exclude_disliked=1")
	if r.Data.Total != 1 || len(r.Data.Items) != 1 || r.Data.Items[0].Name != "清炒时蔬" {
		t.Fatalf("strict 下推荐列表应只剩合规菜，且总数按过滤后计, got %+v", r.Data)
	}
	// 不带参数的普通列表（菜品页/后台）不受影响
	if r := listDishes(t, "enabled=true"); r.Data.Total != 3 {
		t.Fatalf("不带 exclude_disliked 的列表不应过滤, total=%d", r.Data.Total)
	}
	// 与搜索组合：搜"鸡"只剩辣菜，过滤后为空
	if r := listDishes(t, "search="+url.QueryEscape("鸡")+"&exclude_disliked=1"); r.Data.Total != 0 {
		t.Fatalf("搜索结果也应按 strict 忌口过滤, got %+v", r.Data)
	}
}
