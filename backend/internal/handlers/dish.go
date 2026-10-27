package handlers

import (
	"database/sql"
	"encoding/json"
	"math/rand"
	"ninimenu/internal/database"
	"ninimenu/internal/ingredients"
	"ninimenu/internal/models"
	"ninimenu/internal/search"
	"ninimenu/internal/services"
	"ninimenu/internal/utils"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// dishMatchesKeyword 菜品名或主要食材命中关键词：食材走统一别名归一（搜"土豆"能命中写"马铃薯"的菜）
// 并加宽到大类（搜"牛肉"能命中写"牛腩"的菜）；关键词是食材名子串也算命中（搜"排骨"命中）。
// 另支持拼音搜索：关键词去掉非 ASCII 字母后若仍有 ≥2 个字母（如 fqcd、fanqie、tudou），
// 再按菜名全拼/首字母匹配（大小写不敏感）；单字母不参与拼音匹配，避免全拼 Contains 全库误召回。
// 纯中文关键词剥完字母为空、跳过拼音路径仍走原有路径；
// 中英文混合输入（如"fanqie蛋"）原有字面匹配照跑，拼音串按剥完的字母参与匹配。
func dishMatchesKeyword(d models.Dish, keyword string) bool {
	kw := strings.ToLower(strings.TrimSpace(keyword))
	if kw == "" {
		return false
	}
	if strings.Contains(strings.ToLower(d.Name), kw) {
		return true
	}
	// 拼音路径：仅当关键词剥掉非 ASCII 字母后仍有至少 2 个字母才检查（"番茄"剥完为空，跳过）。
	// 单字母不走拼音路径：全拼/首字母 Contains 下 "e/a/i/n" 这类高频字母会命中几乎所有
	// 中文菜名，误召回全库（旧行为下单字母 ASCII 本来匹配不到任何东西）。
	if ascii := asciiLettersOnly(kw); len(ascii) >= 2 && search.PinyinMatch(d.Name, ascii) {
		return true
	}
	for _, ing := range services.ParseDishIngredientNames(d) {
		if strings.Contains(strings.ToLower(ing), kw) {
			return true
		}
		if ingredients.Normalize(ing) == ingredients.Normalize(kw) {
			return true
		}
		if ingredients.CategoryOf(ing) == ingredients.CategoryOf(kw) {
			return true
		}
	}
	return false
}

// asciiLettersOnly 只保留 ASCII 小写字母（入参已小写），其余（汉字/数字/标点/重音字母）全部丢弃
func asciiLettersOnly(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r >= 'a' && r <= 'z' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// sortDishesInMemory 与 SQL 排序对齐的内存排序（搜索命中食材后需内存过滤再分页）
func sortDishesInMemory(dishes []models.Dish, field, order string) {
	sort.SliceStable(dishes, func(i, j int) bool {
		a, b := dishes[i], dishes[j]
		switch field {
		case "name":
			if order == "asc" {
				return a.Name < b.Name
			}
			return a.Name > b.Name
		case "cook_time":
			if order == "asc" {
				return a.CookTime < b.CookTime
			}
			return a.CookTime > b.CookTime
		case "sort_order":
			if order == "asc" {
				return a.SortOrder < b.SortOrder
			}
			return a.SortOrder > b.SortOrder
		case "difficulty":
			if order == "asc" {
				return a.Difficulty < b.Difficulty
			}
			return a.Difficulty > b.Difficulty
		default: // created_at
			if order == "asc" {
				return a.CreatedAt.Before(b.CreatedAt)
			}
			return a.CreatedAt.After(b.CreatedAt)
		}
	})
}

func GetDishes(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 20
	}

	query := database.DB.Model(&models.Dish{})

	if category := c.Query("category"); category != "" {
		query = query.Where("category = ?", category)
	}
	if mealType := c.Query("meal_type"); mealType != "" {
		query = query.Where("meal_type IN ?", []string{mealType, "all"})
	}
	if enabled := c.Query("enabled"); enabled != "" {
		query = query.Where("enabled = ?", enabled == "1" || enabled == "true")
	}
	// 「全部」是前端筛选项的哨兵值（DishList.tsx 只在前端挡掉），直连 API 传「全部」时
	// 若按字面 LIKE 过滤会因不存在分类为「全部」的菜而返回 0 条，这里与前端语义对齐直接忽略
	if taste := c.Query("taste"); taste != "" && taste != "全部" {
		query = query.Where("taste LIKE ?", "%"+taste+"%")
	}
	if difficulty := c.Query("difficulty"); difficulty != "" {
		query = query.Where("difficulty = ?", difficulty)
	}

	searchRaw := c.Query("search")
	sort := c.DefaultQuery("sort", "created_at")
	order := c.DefaultQuery("order", "desc")
	isRandom := sort == "random"
	allowedSorts := map[string]bool{"created_at": true, "name": true, "cook_time": true, "difficulty": true, "sort_order": true, "random": true}
	if !allowedSorts[sort] {
		sort = "created_at"
	}
	if !isRandom {
		if order != "asc" && order != "desc" {
			order = "desc"
		}
		query = query.Order(sort + " " + order)
	}

	// 带关键词的搜索走内存过滤：菜名或食材命中都算（"冰箱里有鸡蛋能做什么"）
	searchTrimmed := strings.TrimSpace(searchRaw)
	if searchTrimmed != "" {
		var all []models.Dish
		if err := query.Find(&all).Error; err != nil {
			utils.InternalError(c, "搜索菜品失败")
			return
		}
		// 拼音索引按全局版本戳刷新（不带任何筛选的 MAX(updated_at)）：未变复用、变了全量重建。
		// 版本戳不能取自下方筛选后的子集：主列表搜索常带 category/taste（DishList.tsx:69-77），
		// 子集 max(updated_at) 随筛选组合漂移，会让缓存在常用路径上被击穿（见 search.Refresh 注释）。
		// 子集未入索引的菜名由 PinyinMatch 现算兜底，正确性不受影响。
		var maxUpdated sql.NullTime
		database.DB.Model(&models.Dish{}).Select("MAX(updated_at)").Scan(&maxUpdated)
		search.Refresh(maxUpdated.Time.UTC().Format(time.RFC3339Nano), all)
		var nameHits, ingredientHits []models.Dish
		kw := strings.ToLower(searchTrimmed)
		for _, d := range all {
			if strings.Contains(strings.ToLower(d.Name), kw) {
				nameHits = append(nameHits, d)
				continue
			}
			if dishMatchesKeyword(d, searchRaw) {
				ingredientHits = append(ingredientHits, d)
			}
		}
		// 菜名命中优先展示，食材命中的跟在后面
		filtered := append(nameHits, ingredientHits...)
		totalFiltered := len(filtered)
		if isRandom {
			rand.Shuffle(len(filtered), func(i, j int) { filtered[i], filtered[j] = filtered[j], filtered[i] })
			if len(filtered) > pageSize {
				filtered = filtered[:pageSize]
			}
		} else {
			sortDishesInMemory(filtered, sort, order)
			offset := (page - 1) * pageSize
			if offset > len(filtered) {
				offset = len(filtered)
			}
			end := offset + pageSize
			if end > len(filtered) {
				end = len(filtered)
			}
			filtered = filtered[offset:end]
		}
		utils.SuccessPaginated(c, filtered, int64(totalFiltered), page, pageSize)
		return
	}

	var total int64
	query.Count(&total)

	var dishes []models.Dish
	if isRandom {
		query.Find(&dishes)
		rand.Shuffle(len(dishes), func(i, j int) { dishes[i], dishes[j] = dishes[j], dishes[i] })
		if len(dishes) > pageSize {
			dishes = dishes[:pageSize]
		}
	} else {
		offset := (page - 1) * pageSize
		query.Offset(offset).Limit(pageSize).Find(&dishes)
	}

	utils.SuccessPaginated(c, dishes, total, page, pageSize)
}

func GetDish(c *gin.Context) {
	id := c.Param("id")
	var dish models.Dish
	if err := database.DB.First(&dish, id).Error; err != nil {
		utils.NotFound(c, "菜品不存在")
		return
	}
	utils.Success(c, dish)
}

type CreateDishRequest struct {
	Name        string `json:"name" binding:"required"`
	ImageURL    string `json:"image_url"`
	Images      string `json:"images"`
	VideoURL    string `json:"video_url"`
	Category    string `json:"category"`
	MealType    string `json:"meal_type"`
	Taste       string `json:"taste"`
	Ingredients string `json:"ingredients"`
	Seasonings  string `json:"seasonings"`
	Steps       string `json:"steps"`
	CookTime    int    `json:"cook_time"`
	Difficulty  string `json:"difficulty"`
	Remark      string `json:"remark"`
	Tags        string `json:"tags"`
	SortOrder   int    `json:"sort_order"`
}

func CreateDish(c *gin.Context) {
	var req CreateDishRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "菜名不能为空")
		return
	}

	dish := models.Dish{
		Name:        req.Name,
		ImageURL:    req.ImageURL,
		Images:      req.Images,
		VideoURL:    req.VideoURL,
		Category:    req.Category,
		MealType:    req.MealType,
		Taste:       req.Taste,
		Ingredients: req.Ingredients,
		Seasonings:  req.Seasonings,
		Steps:       req.Steps,
		CookTime:    req.CookTime,
		Difficulty:  req.Difficulty,
		Remark:      req.Remark,
		Tags:        req.Tags,
		SortOrder:   req.SortOrder,
		Enabled:     true,
	}

	if dish.MealType == "" {
		dish.MealType = "all"
	}
	if dish.Difficulty == "" {
		dish.Difficulty = "easy"
	}
	if dish.Images == "" {
		dish.Images = "[]"
	}
	if dish.Ingredients == "" {
		dish.Ingredients = "[]"
	}
	if dish.Seasonings == "" {
		dish.Seasonings = "[]"
	}
	if dish.Steps == "" {
		dish.Steps = "[]"
	}
	if dish.Tags == "" {
		dish.Tags = "[]"
	}

	if err := database.DB.Create(&dish).Error; err != nil {
		utils.InternalError(c, "创建菜品失败")
		return
	}

	services.QueueAutoAchievementSync()
	utils.Success(c, dish)
}

func UpdateDish(c *gin.Context) {
	id := c.Param("id")
	var dish models.Dish
	if err := database.DB.First(&dish, id).Error; err != nil {
		utils.NotFound(c, "菜品不存在")
		return
	}

	var req CreateDishRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		utils.BadRequest(c, "请求数据无效")
		return
	}

	dish.Name = req.Name
	dish.ImageURL = req.ImageURL
	dish.Images = req.Images
	dish.VideoURL = req.VideoURL
	dish.Category = req.Category
	dish.MealType = req.MealType
	dish.Taste = req.Taste
	dish.Ingredients = req.Ingredients
	dish.Seasonings = req.Seasonings
	dish.Steps = req.Steps
	dish.CookTime = req.CookTime
	dish.Difficulty = req.Difficulty
	dish.Remark = req.Remark
	dish.Tags = req.Tags
	dish.SortOrder = req.SortOrder

	if err := database.DB.Save(&dish).Error; err != nil {
		utils.InternalError(c, "更新菜品失败")
		return
	}

	services.QueueAutoAchievementSync()
	utils.Success(c, dish)
}

func DeleteDish(c *gin.Context) {
	id := c.Param("id")
	if err := database.DB.Delete(&models.Dish{}, id).Error; err != nil {
		utils.NotFound(c, "菜品不存在")
		return
	}
	services.QueueAutoAchievementSync()
	utils.SuccessMsg(c, "删除成功")
}

func ToggleDish(c *gin.Context) {
	id := c.Param("id")
	var dish models.Dish
	if err := database.DB.First(&dish, id).Error; err != nil {
		utils.NotFound(c, "菜品不存在")
		return
	}
	dish.Enabled = !dish.Enabled
	database.DB.Save(&dish)
	services.QueueAutoAchievementSync()
	utils.Success(c, dish)
}

func CloneDish(c *gin.Context) {
	id := c.Param("id")
	var dish models.Dish
	if err := database.DB.First(&dish, id).Error; err != nil {
		utils.NotFound(c, "菜品不存在")
		return
	}

	newDish := dish
	newDish.ID = 0
	newDish.Name = dish.Name + " (副本)"
	if err := database.DB.Create(&newDish).Error; err != nil {
		utils.InternalError(c, "克隆菜品失败")
		return
	}

	services.QueueAutoAchievementSync()
	utils.Success(c, newDish)
}

type CategoryCount struct {
	Category string `json:"category"`
	Count    int64  `json:"count"`
}

func GetDishCategoryCounts(c *gin.Context) {
	var counts []CategoryCount
	database.DB.Model(&models.Dish{}).
		Select("category, count(*) as count").
		Where("enabled = ? AND deleted_at IS NULL", true).
		Group("category").
		Order("count DESC").
		Find(&counts)

	var total int64
	database.DB.Model(&models.Dish{}).Where("enabled = ? AND deleted_at IS NULL", true).Count(&total)

	utils.Success(c, gin.H{
		"total":      total,
		"categories": counts,
	})
}

type BatchToggleRequest struct {
	IDs     []uint `json:"ids" binding:"required"`
	Enabled bool   `json:"enabled"`
}

func BatchToggleDishes(c *gin.Context) {
	var req BatchToggleRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.IDs) == 0 {
		utils.BadRequest(c, "请选择菜品")
		return
	}
	database.DB.Model(&models.Dish{}).Where("id IN ?", req.IDs).Update("enabled", req.Enabled)
	services.QueueAutoAchievementSync()
	utils.SuccessMsg(c, "批量操作成功")
}

type BatchDeleteRequest struct {
	IDs []uint `json:"ids" binding:"required"`
}

func BatchDeleteDishes(c *gin.Context) {
	var req BatchDeleteRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.IDs) == 0 {
		utils.BadRequest(c, "请选择菜品")
		return
	}
	database.DB.Where("id IN ?", req.IDs).Delete(&models.Dish{})
	services.QueueAutoAchievementSync()
	utils.SuccessMsg(c, "批量删除成功")
}

type BatchCategoryRequest struct {
	IDs      []uint `json:"ids" binding:"required"`
	Category string `json:"category" binding:"required"`
}

func BatchUpdateCategory(c *gin.Context) {
	var req BatchCategoryRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.IDs) == 0 {
		utils.BadRequest(c, "请选择菜品并指定分类")
		return
	}
	database.DB.Model(&models.Dish{}).Where("id IN ?", req.IDs).Update("category", req.Category)
	utils.SuccessMsg(c, "批量修改分类成功")
}

type DishRecordWithDay struct {
	ID        uint     `json:"id"`
	MealType  string   `json:"meal_type"`
	MealDate  string   `json:"meal_date"`
	Rating    int      `json:"rating"`
	Remark    string   `json:"remark"`
	Mood      string   `json:"mood"`
	Photo     string   `json:"photo"`
	HomeMood  string   `json:"home_mood"`
	DayMood   string   `json:"day_mood"`
	DayRemark string   `json:"day_remark"`
	Photos    []string `json:"photos"`
}

type DishRecordsStats struct {
	TotalCount  int     `json:"total_count"`
	LunchCount  int     `json:"lunch_count"`
	DinnerCount int     `json:"dinner_count"`
	YumPercent  int     `json:"yum_percent"`
	OkPercent   int     `json:"ok_percent"`
	NoPercent   int     `json:"no_percent"`
	AvgRating   float64 `json:"avg_rating"`
	LastDate    string  `json:"last_date"`
	AvgInterval int     `json:"avg_interval"`
}

type DishRecordsResponse struct {
	Records []DishRecordWithDay `json:"records"`
	Stats   DishRecordsStats    `json:"stats"`
}

func GetDishRecords(c *gin.Context) {
	id := c.Param("id")
	var dish models.Dish
	if err := database.DB.First(&dish, id).Error; err != nil {
		utils.NotFound(c, "菜品不存在")
		return
	}

	var records []models.MealRecord
	database.DB.Where("dish_id = ?", id).Order("meal_date DESC, created_at DESC").Find(&records)

	if len(records) == 0 {
		utils.Success(c, DishRecordsResponse{
			Records: []DishRecordWithDay{},
			Stats:   DishRecordsStats{},
		})
		return
	}

	dates := make([]string, 0, len(records))
	for _, r := range records {
		dates = append(dates, r.MealDate)
	}

	dayRatingMap := make(map[string]models.DayRating)
	if len(dates) > 0 {
		var dayRatings []models.DayRating
		database.DB.Where("meal_date IN ?", dates).Find(&dayRatings)
		for _, dr := range dayRatings {
			dayRatingMap[dr.MealDate] = dr
		}
	}

	result := make([]DishRecordWithDay, 0, len(records))
	yumCount := 0
	okCount := 0
	noCount := 0
	totalRating := 0
	ratingCount := 0
	lunchCount := 0

	for _, r := range records {
		var photos []string
		var homeMood, dayMood, dayRemark string
		if dr, ok := dayRatingMap[r.MealDate]; ok {
			homeMood = dr.HomeMood
			dayMood = dr.Mood
			dayRemark = dr.Remark
			if dr.Photos != "" {
				json.Unmarshal([]byte(dr.Photos), &photos)
			}
		}
		if photos == nil {
			photos = []string{}
		}

		switch r.Mood {
		case "yum", "great":
			yumCount++
		case "ok":
			okCount++
		case "no", "meh":
			noCount++
		}
		if r.Rating > 0 {
			totalRating += r.Rating
			ratingCount++
		}
		if r.MealType == "lunch" {
			lunchCount++
		}

		result = append(result, DishRecordWithDay{
			ID:        r.ID,
			MealType:  r.MealType,
			MealDate:  r.MealDate,
			Rating:    r.Rating,
			Remark:    r.Remark,
			Mood:      r.Mood,
			Photo:     r.Photo,
			HomeMood:  homeMood,
			DayMood:   dayMood,
			DayRemark: dayRemark,
			Photos:    photos,
		})
	}

	total := len(records)
	yumPct := 0
	okPct := 0
	noPct := 0
	moodTotal := yumCount + okCount + noCount
	if moodTotal > 0 {
		yumPct = yumCount * 100 / moodTotal
		okPct = okCount * 100 / moodTotal
		noPct = noCount * 100 / moodTotal
	}

	avgRating := 0.0
	if ratingCount > 0 {
		avgRating = float64(totalRating) / float64(ratingCount)
	}

	lastDate := records[0].MealDate

	var avgInterval int
	if total >= 2 {
		sorted := make([]string, len(records))
		for i, r := range records {
			sorted[i] = r.MealDate
		}
		totalDays := 0
		for i := 0; i < len(sorted)-1; i++ {
			d1, e1 := time.Parse("2006-01-02", sorted[i])
			d2, e2 := time.Parse("2006-01-02", sorted[i+1])
			if e1 == nil && e2 == nil {
				diff := int(d1.Sub(d2).Hours() / 24)
				if diff > 0 {
					totalDays += diff
				}
			}
		}
		avgInterval = totalDays / (len(sorted) - 1)
	}

	utils.Success(c, DishRecordsResponse{
		Records: result,
		Stats: DishRecordsStats{
			TotalCount:  total,
			LunchCount:  lunchCount,
			DinnerCount: total - lunchCount,
			YumPercent:  yumPct,
			OkPercent:   okPct,
			NoPercent:   noPct,
			AvgRating:   avgRating,
			LastDate:    lastDate,
			AvgInterval: avgInterval,
		},
	})
}
