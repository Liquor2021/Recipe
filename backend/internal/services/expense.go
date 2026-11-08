package services

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"ninimenu/internal/models"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const MaxExpenseCents int64 = 99999999

var ExpenseCategories = []string{"ingredients", "takeout", "seasoning", "kitchenware", "other"}
var ErrExpenseConflict = errors.New("这笔账已被修改或删除，请刷新后再试")
var ErrExpenseRequestConflict = errors.New("这次记账请求已处理，请刷新账本确认")
var ErrShoppingAlreadyPurchased = errors.New("这份食材已买，请刷新清单；补记支出可到厨房账本")
var expenseRequestID = regexp.MustCompile(`^[A-Za-z0-9_-]{16,80}$`)

type ExpenseInput struct {
	AmountCents int64  `json:"amount_cents"`
	Category    string `json:"category"`
	ExpenseDate string `json:"expense_date"`
	Note        string `json:"note"`
	RequestID   string `json:"request_id"`
}

func ValidExpenseMonth(month string) bool {
	d, err := time.Parse("2006-01", month)
	return err == nil && d.Year() >= 1900 && d.Format("2006-01") == month
}

func ValidateExpense(input *ExpenseInput, creating bool) error {
	if input.AmountCents <= 0 || input.AmountCents > MaxExpenseCents {
		return errors.New("金额须为 0.01～999999.99 元，最多两位小数")
	}
	validCategory := false
	for _, category := range ExpenseCategories {
		validCategory = validCategory || input.Category == category
	}
	if !validCategory {
		return errors.New("请选择有效的支出分类")
	}
	d, err := time.Parse("2006-01-02", input.ExpenseDate)
	if err != nil || d.Year() < 1900 || d.Format("2006-01-02") != input.ExpenseDate || input.ExpenseDate > TodayDate() {
		return errors.New("请选择今天或之前的有效日期")
	}
	input.Note = strings.TrimSpace(input.Note)
	if utf8.RuneCountInString(input.Note) > 200 {
		return errors.New("备注最多 200 字")
	}
	if creating && !expenseRequestID.MatchString(input.RequestID) {
		return errors.New("记账请求号无效，请重新打开抽屉")
	}
	return nil
}

// 调用方负责事务和校验。先尝试插入取得写锁，同请求重复提交返回原记录。
func CreateExpenseTx(tx *gorm.DB, input ExpenseInput, source, shoppingItem, context string) (models.Expense, bool, error) {
	body, _ := json.Marshal([]any{input.AmountCents, input.Category, input.ExpenseDate, input.Note, source, shoppingItem, context})
	sum := sha256.Sum256(body)
	expense := models.Expense{AmountCents: input.AmountCents, Category: input.Category, ExpenseDate: input.ExpenseDate,
		Note: input.Note, Source: source, ShoppingItem: shoppingItem, RequestID: input.RequestID,
		RequestHash: hex.EncodeToString(sum[:]), Revision: 1}
	res := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "request_id"}}, DoNothing: true}).Create(&expense)
	if res.Error != nil {
		return expense, false, res.Error
	}
	if res.RowsAffected > 0 {
		return expense, true, nil
	}
	var existing models.Expense
	if err := tx.Unscoped().Where("request_id = ?", input.RequestID).First(&existing).Error; err != nil {
		return expense, false, err
	}
	if existing.DeletedAt.Valid || existing.RequestHash != expense.RequestHash {
		return existing, false, ErrExpenseRequestConflict
	}
	return existing, false, nil
}
