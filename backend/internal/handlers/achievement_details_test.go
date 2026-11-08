package handlers

import (
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestAchievementDetailsRejectsInvalidIDs(t *testing.T) {
	setupHandlerTestDB(t, &models.Achievement{})
	database.DB.Create(&models.Achievement{Code: "example", Name: "示例成就", Condition: "manual"})
	for _, id := range []string{"0", "-1", "abc", "1 OR 1=1", "18446744073709551616"} {
		w := serveJSON(t, GetAchievementDetails, "GET", "/api/achievements/invalid", nil, gin.Param{Key: "id", Value: id})
		if w.Code != 400 {
			t.Fatalf("无效编号 %q 应返回400，实际 %d %s", id, w.Code, w.Body.String())
		}
	}
	w := serveJSON(t, GetAchievementDetails, "GET", "/api/achievements/999", nil, gin.Param{Key: "id", Value: "999"})
	if w.Code != 404 {
		t.Fatalf("不存在的成就应返回404，实际 %d %s", w.Code, w.Body.String())
	}
}
