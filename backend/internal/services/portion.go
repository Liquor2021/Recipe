package services

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// PortionScale 是相对原菜谱的倍数，不推断菜谱原本供几个人吃。
func ValidPortionScale(scale float64) bool {
	return !math.IsNaN(scale) && !math.IsInf(scale, 0) && scale >= 0.5 && scale <= 8
}

// 仅缩放明确的单一数量；范围、分数、复合数量和“适量”等保持原文。
var scalableAmount = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z\x{3400}-\x{9fff}]*)$`)

func ScaleIngredientAmount(amount string, scale float64) string {
	if scale == 1 {
		return amount
	}
	m := scalableAmount.FindStringSubmatch(strings.TrimSpace(amount))
	if m == nil {
		return amount
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil || math.IsInf(n*scale, 0) || math.IsNaN(n*scale) {
		return amount
	}
	return strconv.FormatFloat(math.Round(n*scale*100)/100, 'f', -1, 64) + strings.TrimSpace(m[2])
}
