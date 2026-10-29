package handlers

import (
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

func GetWeekPlan(c *gin.Context) {
	plan := services.GetCachedWeekPlan()
	if plan != nil && len(plan.Days) > 0 {
		services.RecordUniqueAchievementEvent("week_plan", plan.Days[0].Date)
	}
	utils.Success(c, plan)
}

func RegenerateWeekPlanHandler(c *gin.Context) {
	plan := services.RegenerateWeekPlan()
	services.RecordAchievementEvent("week_plan", "")
	utils.Success(c, plan)
}

func GetShoppingList(c *gin.Context) {
	today := time.Now().Format("2006-01-02")
	tomorrow := time.Now().AddDate(0, 0, 1).Format("2006-01-02")
	dates := []string{today, tomorrow}

	list, err := services.BuildShoppingList(dates)
	if err != nil {
		utils.InternalError(c, "加载买菜清单失败")
		return
	}
	utils.Success(c, list)
}

type ToggleShoppingCheckRequest struct {
	ItemName string `json:"item_name" binding:"required"`
	MealDate string `json:"meal_date" binding:"required"`
	Checked  bool   `json:"checked"`
}

func ToggleShoppingCheckHandler(c *gin.Context) {
	var req ToggleShoppingCheckRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	if err := services.ToggleShoppingCheck(req.ItemName, req.Checked); err != nil {
		utils.InternalError(c, "更新失败")
		return
	}
	if req.Checked {
		services.QueueAutoAchievementSync()
	}
	utils.SuccessMsg(c, "已更新")
}

type ToggleHomeInventoryRequest struct {
	ItemName string `json:"item_name" binding:"required"`
	InStock  bool   `json:"in_stock"`
}

func ToggleHomeInventoryHandler(c *gin.Context) {
	var req ToggleHomeInventoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	if err := services.ToggleHomeInventory(req.ItemName, req.InStock); err != nil {
		if errors.Is(err, services.ErrEmptyItemName) {
			utils.BadRequest(c, "参数无效")
			return
		}
		utils.InternalError(c, "库存状态更新失败")
		return
	}
	services.QueueAutoAchievementSync()
	utils.SuccessMsg(c, "已更新")
}

type AddShoppingItemsRequest struct {
	DishID   uint   `json:"dish_id"`
	DishName string `json:"dish_name"`
	MealDate string `json:"meal_date"`
	Items    []struct {
		Name   string `json:"name" binding:"required"`
		Amount string `json:"amount"`
	} `json:"items" binding:"required,min=1"`
}

// AddShoppingItemsHandler 清冰箱推荐"补料"等场景：手动往买菜清单加条目
func AddShoppingItemsHandler(c *gin.Context) {
	var req AddShoppingItemsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	items := make([]services.ShoppingItem, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, services.ShoppingItem{Name: it.Name, Amount: it.Amount})
	}
	added, err := services.AddShoppingListItems(items, req.DishID, req.DishName, strings.TrimSpace(req.MealDate))
	if err != nil {
		utils.InternalError(c, "加入买菜清单失败")
		return
	}
	// 前端按 added 数值组织提示文案（0 = 清单里已存在）
	utils.Success(c, gin.H{"added": added})
}

func GetShoppingCategories(c *gin.Context) {
	utils.Success(c, services.ListShoppingCategoryOverrides())
}

type UpsertShoppingCategoryRequest struct {
	ItemName string `json:"item_name" binding:"required"`
	Category string `json:"category" binding:"required"`
}

func UpsertShoppingCategoryHandler(c *gin.Context) {
	var req UpsertShoppingCategoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	ok, err := services.UpsertShoppingCategoryOverride(req.ItemName, req.Category)
	if err != nil {
		utils.InternalError(c, "保存失败")
		return
	}
	if !ok {
		utils.BadRequest(c, "分类无效")
		return
	}
	utils.SuccessMsg(c, "已更新")
}

func DeleteShoppingCategoryHandler(c *gin.Context) {
	itemName := c.Param("itemName")
	if err := services.DeleteShoppingCategoryOverride(itemName); err != nil {
		utils.InternalError(c, "删除失败")
		return
	}
	utils.SuccessMsg(c, "已删除")
}

func GetUpcomingHolidays(c *gin.Context) {
	var holidays []models.Holiday
	now := time.Now().Format("2006-01-02")
	database.DB.Where("date >= ?", now).Order("date ASC").Limit(5).Find(&holidays)
	utils.Success(c, holidays)
}
