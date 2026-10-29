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
	list, err := services.BuildShoppingList(services.ShoppingListDates())
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

// RemoveShoppingItemHandler 从买菜清单删掉补料条目（误点补料的撤销入口）
func RemoveShoppingItemHandler(c *gin.Context) {
	removed, err := services.RemoveShoppingExtraItem(c.Param("itemName"))
	if err != nil {
		if errors.Is(err, services.ErrEmptyItemName) {
			utils.BadRequest(c, "参数无效")
			return
		}
		utils.InternalError(c, "删除失败")
		return
	}
	utils.Success(c, gin.H{"removed": removed})
}

type StockInRequest struct {
	Items []struct {
		ItemName string `json:"item_name"`
		Quantity string `json:"quantity"`
	} `json:"items"`
}

// StockInShoppingItemsHandler 把买菜清单里已买的食材放进冰箱（保质期按食材字典自动设置）
func StockInShoppingItemsHandler(c *gin.Context) {
	var req StockInRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "参数无效")
		return
	}
	if len(req.Items) == 0 || len(req.Items) > 50 {
		utils.BadRequest(c, "请选择要放进冰箱的食材（一次最多 50 样）")
		return
	}
	items := make([]services.StockInItem, 0, len(req.Items))
	for _, it := range req.Items {
		name := strings.TrimSpace(it.ItemName)
		qty := strings.TrimSpace(it.Quantity)
		if name == "" || len([]rune(name)) > 50 || len([]rune(qty)) > 50 {
			utils.BadRequest(c, "食材名称或数量无效")
			return
		}
		items = append(items, services.StockInItem{ItemName: name, Quantity: qty})
	}
	added, err := services.StockInShoppingItems(items)
	if err != nil {
		utils.InternalError(c, "放进冰箱失败")
		return
	}
	services.QueueAutoAchievementSync()
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
