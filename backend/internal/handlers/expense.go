package handlers

import (
	"errors"
	"ninimenu/internal/database"
	"ninimenu/internal/models"
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func expenseError(c *gin.Context, err error) {
	if errors.Is(err, services.ErrExpenseConflict) || errors.Is(err, services.ErrExpenseRequestConflict) {
		utils.Conflict(c, err.Error())
	} else {
		utils.InternalError(c, "账本未能保存，请重试")
	}
}

func GetExpenses(c *gin.Context) {
	month := c.DefaultQuery("month", time.Now().Format("2006-01"))
	if !services.ValidExpenseMonth(month) {
		utils.BadRequest(c, "月份格式应为 YYYY-MM")
		return
	}
	start, _ := time.Parse("2006-01", month)
	entries := []models.Expense{}
	var previousTotal, budget int64
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("expense_date >= ? AND expense_date < ?", month+"-01", start.AddDate(0, 1, 0).Format("2006-01-02")).Order("expense_date DESC, id DESC").Find(&entries).Error; err != nil {
			return err
		}
		if err := tx.Model(&models.Expense{}).Where("expense_date >= ? AND expense_date < ?", start.AddDate(0, -1, 0).Format("2006-01-02"), month+"-01").Select("coalesce(sum(amount_cents), 0)").Scan(&previousTotal).Error; err != nil {
			return err
		}
		var setting models.Setting
		err := tx.Where("`key` = ?", "ledger_budget:"+month).First(&setting).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		budget, err = strconv.ParseInt(setting.Value, 10, 64)
		if err == nil && (budget < 0 || budget > services.MaxExpenseCents) {
			return errors.New("invalid budget")
		}
		return err
	})
	if err != nil {
		utils.InternalError(c, "读取账本失败，请重试")
		return
	}
	var total int64
	categories := make(map[string]int64, len(services.ExpenseCategories))
	for _, category := range services.ExpenseCategories {
		categories[category] = 0
	}
	for _, expense := range entries {
		total += expense.AmountCents
		categories[expense.Category] += expense.AmountCents
	}
	c.Header("Cache-Control", "no-store")
	utils.Success(c, gin.H{"month": month, "entries": entries, "total_cents": total, "previous_total_cents": previousTotal, "budget_cents": budget, "categories": categories})
}

func CreateExpense(c *gin.Context) {
	var req services.ExpenseInput
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "记账参数无效，金额须精确到分")
		return
	}
	if err := services.ValidateExpense(&req, true); err != nil {
		utils.BadRequest(c, err.Error())
		return
	}
	var expense models.Expense
	err := database.DB.Transaction(func(tx *gorm.DB) error {
		var err error
		expense, _, err = services.CreateExpenseTx(tx, req, "manual", "", "")
		return err
	})
	if err != nil {
		expenseError(c, err)
		return
	}
	utils.Success(c, expense)
}

type updateExpenseRequest struct {
	services.ExpenseInput
	Revision int `json:"revision"`
}

func expenseID(c *gin.Context) (uint64, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil || id == 0 {
		utils.BadRequest(c, "账目编号无效")
		return 0, false
	}
	return id, true
}

func UpdateExpense(c *gin.Context) {
	id, ok := expenseID(c)
	if !ok {
		return
	}
	var req updateExpenseRequest
	if err := c.ShouldBindJSON(&req); err != nil || req.Revision <= 0 {
		utils.BadRequest(c, "记账参数无效")
		return
	}
	if err := services.ValidateExpense(&req.ExpenseInput, false); err != nil {
		utils.BadRequest(c, err.Error())
		return
	}
	res := database.DB.Model(&models.Expense{}).Where("id = ? AND revision = ?", id, req.Revision).Updates(map[string]any{
		"amount_cents": req.AmountCents, "category": req.Category, "expense_date": req.ExpenseDate, "note": req.Note, "revision": gorm.Expr("revision + 1"),
	})
	if res.Error != nil {
		expenseError(c, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		expenseError(c, services.ErrExpenseConflict)
		return
	}
	utils.SuccessMsg(c, "已修改")
}

func DeleteExpense(c *gin.Context) {
	id, ok := expenseID(c)
	if !ok {
		return
	}
	var req struct {
		Revision int `json:"revision"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Revision <= 0 {
		utils.BadRequest(c, "请刷新账本后再删除")
		return
	}
	res := database.DB.Where("id = ? AND revision = ?", id, req.Revision).Delete(&models.Expense{})
	if res.Error != nil {
		expenseError(c, res.Error)
		return
	}
	if res.RowsAffected == 0 {
		expenseError(c, services.ErrExpenseConflict)
		return
	}
	utils.SuccessMsg(c, "已删除")
}

func saveLedgerSetting(key, value string) error {
	return database.DB.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "key"}}, DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"})}).Create(&models.Setting{Key: key, Value: value}).Error
}

func SetLedgerBudget(c *gin.Context) {
	month := c.Param("month")
	var req struct {
		AmountCents *int64 `json:"amount_cents"`
	}
	if !services.ValidExpenseMonth(month) || c.ShouldBindJSON(&req) != nil || req.AmountCents == nil || *req.AmountCents < 0 || *req.AmountCents > services.MaxExpenseCents {
		utils.BadRequest(c, "预算须为 0～999999.99 元，最多两位小数")
		return
	}
	if err := saveLedgerSetting("ledger_budget:"+month, strconv.FormatInt(*req.AmountCents, 10)); err != nil {
		expenseError(c, err)
		return
	}
	utils.SuccessMsg(c, "预算已保存")
}

func GetLedgerSettings(c *gin.Context) {
	var setting models.Setting
	err := database.DB.Where("`key` = ?", "ledger_shopping_enabled").First(&setting).Error
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		utils.InternalError(c, "读取记账偏好失败")
		return
	}
	c.Header("Cache-Control", "no-store")
	utils.Success(c, gin.H{"shopping_link_enabled": setting.Value == "1"})
}

func SetLedgerSettings(c *gin.Context) {
	var req struct {
		Enabled *bool `json:"shopping_link_enabled"`
	}
	if c.ShouldBindJSON(&req) != nil || req.Enabled == nil {
		utils.BadRequest(c, "请指定采购记账偏好")
		return
	}
	value := "0"
	if *req.Enabled {
		value = "1"
	}
	if err := saveLedgerSetting("ledger_shopping_enabled", value); err != nil {
		expenseError(c, err)
		return
	}
	utils.Success(c, gin.H{"shopping_link_enabled": *req.Enabled})
}
