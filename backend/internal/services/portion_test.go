package services

import (
	"math"
	"ninimenu/internal/models"
	"testing"
	"time"
)

func TestScaleIngredientAmount(t *testing.T) {
	for _, tc := range []struct {
		amount string
		scale  float64
		want   string
	}{
		{"250克", 2, "500克"}, {"0.5 kg", 3, "1.5kg"}, {"3", 2, "6"},
		{"0.333个", 2, "0.67个"}, {"少许", 4, "少许"}, {"适量", 0.5, "适量"},
		{"", 2, ""}, {"1-2个", 2, "1-2个"}, {"1/2勺", 2, "1/2勺"},
		{"2勺+1勺", 2, "2勺+1勺"}, {"200g（去皮后）", 2, "200g（去皮后）"},
	} {
		if got := ScaleIngredientAmount(tc.amount, tc.scale); got != tc.want {
			t.Errorf("scale(%q, %v)=%q, want %q", tc.amount, tc.scale, got, tc.want)
		}
	}
	for _, scale := range []float64{0, -1, 0.49, 8.01, math.Inf(1), math.NaN()} {
		if ValidPortionScale(scale) {
			t.Errorf("invalid scale accepted: %v", scale)
		}
	}
}

func TestConsumptionUsesScaledRecipeAmount(t *testing.T) {
	dish := models.Dish{Ingredients: `[{"name":"番茄","amount":"2个"}]`}
	batches := []models.InventoryBatch{{ID: 1, ItemName: "番茄", Quantity: "7个"}}
	slots := matchDishConsumption(dish, batches, time.Now(), 2)
	if len(slots) != 1 || slots[0].Amount != "4个" || slots[0].Batches[0].RemainingHint != "3个" {
		t.Fatalf("两倍菜谱应使用4个并剩3个: %+v", slots)
	}
	if got := remainingAfterUse("5-6个", "2个"); got != "" {
		t.Fatalf("范围不能算作单位: %q", got)
	}
}
