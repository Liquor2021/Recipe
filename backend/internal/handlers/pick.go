package handlers

import (
	"math/rand"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type PickRequest struct {
	Mood string `json:"mood"`
}

type TomorrowPickRequest struct {
	MealType   string `json:"meal_type"`
	Profile    string `json:"profile"`
	Count      int    `json:"count"`
	ExcludeIDs []uint `json:"exclude_ids"`
}

func PickLunch(c *gin.Context) {
	count := getPickCount(c)
	dishes, err := services.PickDishes("lunch", count, true)
	if err != nil || len(dishes) == 0 {
		utils.NotFound(c, "没有可推荐的菜品")
		return
	}
	services.RecordAchievementEvent("recommend_lunch", "")
	quote := services.GetRandomQuote("lunch")
	utils.Success(c, gin.H{
		"dishes": dishes,
		"quote":  quote,
	})
}

func PickDinner(c *gin.Context) {
	count := getPickCount(c)
	dishes, err := services.PickDishes("dinner", count, true)
	if err != nil || len(dishes) == 0 {
		utils.NotFound(c, "没有可推荐的菜品")
		return
	}
	services.RecordAchievementEvent("recommend_dinner", "")
	quote := services.GetRandomQuote("dinner")
	utils.Success(c, gin.H{
		"dishes": dishes,
		"quote":  quote,
	})
}

func PickMood(c *gin.Context) {
	var req PickRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "请选择心情")
		return
	}

	dishes, scene := services.PickMoodDishes(req.Mood, 3)
	if len(dishes) == 0 {
		utils.NotFound(c, "没有可推荐的菜品")
		return
	}
	services.RecordAchievementEvent("recommend_mood", "")
	utils.Success(c, gin.H{"dishes": dishes, "quote": services.GetRandomQuote(scene)})
}

func PickTomorrow(c *gin.Context) {
	var req TomorrowPickRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "请求数据无效")
		return
	}

	dishes, err := services.PickTomorrowDishes(services.TomorrowPickOptions{
		MealType:   req.MealType,
		Profile:    req.Profile,
		Count:      req.Count,
		ExcludeIDs: req.ExcludeIDs,
	})
	if err != nil || len(dishes) == 0 {
		utils.NotFound(c, "没有可推荐的菜品")
		return
	}

	services.RecordAchievementEvent("recommend_mood", req.Profile)
	utils.Success(c, gin.H{
		"dishes": dishes,
		"quote":  services.GetRandomQuote(req.Profile),
	})
}

func PickBlindBox(c *gin.Context) {
	var dishes []models.Dish
	database.DB.Where("enabled = ?", true).Find(&dishes)
	// 盲盒是给全家看的单菜惊喜：优先排除命中家庭忌口的菜（strict 下全被排除就没有盲盒）
	dishes = services.PreferNonDisliked(dishes)
	if len(dishes) == 0 {
		utils.NotFound(c, "没有可推荐的菜品")
		return
	}

	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	dish := dishes[r.Intn(len(dishes))]

	hint := "点我揭晓今日惊喜~"
	var box models.BlindBox
	if err := database.DB.Session(&gorm.Session{Logger: logger.Default.LogMode(logger.Silent)}).Where("active = ?", true).First(&box).Error; err == nil && box.Hint != "" {
		hint = box.Hint
	}

	services.RecordAchievementEvent("blind_box", "")
	utils.Success(c, gin.H{
		"hint":  hint,
		"dish":  dish,
		"quote": services.GetRandomQuote(""),
	})
}

func getPickCount(c *gin.Context) int {
	count, err := strconv.Atoi(c.DefaultQuery("count", "3"))
	if err != nil || count < 1 {
		count = 3
	}
	if count > 10 {
		count = 10
	}
	return count
}
