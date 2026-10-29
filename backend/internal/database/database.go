package database

import (
	"encoding/json"
	"fmt"
	"ninimenu/internal/achievements"
	"ninimenu/internal/config"
	"ninimenu/internal/dishes"
	"ninimenu/internal/models"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

var DB *gorm.DB

func Init() error {
	dir := filepath.Dir(config.C.DBPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	var err error
	DB, err = gorm.Open(sqlite.Open(config.C.DBPath), &gorm.Config{})
	if err != nil {
		return err
	}
	if err := configureSQLite(DB); err != nil {
		return err
	}

	if err := DB.AutoMigrate(
		&models.Dish{},
		&models.MealRecord{},
		&models.Favorite{},
		&models.Quote{},
		&models.Achievement{},
		&models.UserAchievement{},
		&models.AchievementEvent{},
		&models.BlindBox{},
		&models.Holiday{},
		&models.Setting{},
		&models.DayRating{},
		&models.ShoppingCheck{},
		&models.InventoryBatch{},
		&models.ShoppingItemCategory{},
	); err != nil {
		return err
	}

	migrateMealRecordUniqueIndex(DB)
	migrateInventoryBatches(DB)

	seedData()
	return nil
}

// migrateInventoryBatches 把库存表从"一食材一行（唯一索引）"升级为"多批次"模型：
// 去掉 item_name 唯一索引，允许同一食材并存多个批次（各自数量与到期日）。
// 旧数据每食材恰好一行，天然成为该食材的首个批次，无需合并。
func migrateInventoryBatches(db *gorm.DB) {
	if err := db.Exec(`DROP INDEX IF EXISTS idx_home_inventory_item_name`).Error; err != nil {
		fmt.Printf("[migrate] 删除库存旧唯一索引失败，同一食材暂时无法追加新批次: %v\n", err)
	}
}

// mealRecordUniqueIndex 同菜同餐同日唯一索引名（模型 tag 只声明普通索引，见 models.MealRecord）
const mealRecordUniqueIndex = "idx_meal_records_unique_day"

// migrateMealRecordUniqueIndex 把同菜同餐同日的普通索引升级为唯一索引（已是唯一索引则跳过）。
// 必须在 AutoMigrate 之后、且模型 tag 不能写 uniqueIndex：否则 AutoMigrate 会先于这里
// 建唯一索引，旧库只要有重复记录就直接启动失败。为避免丢数据：
//   - 删除前把所有涉及重复的原始行备份到 meal_records_dedup_backup；
//   - 重复行合并进最早一条：评分/照片/心情补空缺，不同的备注拼接保留；
//   - 备份、合并、删除、建唯一索引在同一事务里，任何一步失败整体回滚，
//     数据与原普通索引原样保留（重复只由写入时的预检拦截），下次启动再试。
//
// 迁移失败只记日志不阻断启动：唯一索引是兜底约束，不应让应用起不来。
func migrateMealRecordUniqueIndex(db *gorm.DB) {
	unique, err := indexIsUnique(db, "meal_records", mealRecordUniqueIndex)
	if err != nil {
		fmt.Printf("[migrate] 读取用餐记录索引信息失败，本次跳过唯一索引升级: %v\n", err)
		return
	}
	if unique {
		return
	}

	merged := 0
	err = db.Transaction(func(tx *gorm.DB) error {
		type keyRow struct {
			DishID   uint
			MealType string
			MealDate string
		}
		var keys []keyRow
		if err := tx.Model(&models.MealRecord{}).
			Select("dish_id, meal_type, meal_date").
			Group("dish_id, meal_type, meal_date").
			Having("count(*) > 1").
			Scan(&keys).Error; err != nil {
			return fmt.Errorf("查询重复记录: %w", err)
		}
		if len(keys) > 0 {
			if err := backupDuplicateMealRecords(tx); err != nil {
				return err
			}
		}
		for _, k := range keys {
			if err := mergeDuplicateMealRecords(tx, k.DishID, k.MealType, k.MealDate); err != nil {
				return err
			}
		}
		merged = len(keys)

		if err := tx.Exec("DROP INDEX IF EXISTS " + mealRecordUniqueIndex).Error; err != nil {
			return fmt.Errorf("删除普通索引: %w", err)
		}
		// 不加 IF NOT EXISTS：同名索引若还在说明上一步没删掉，必须报错回滚而不是静默留下普通索引
		if err := tx.Exec("CREATE UNIQUE INDEX " + mealRecordUniqueIndex + " ON meal_records(dish_id, meal_type, meal_date)").Error; err != nil {
			return fmt.Errorf("创建唯一索引: %w", err)
		}
		return nil
	})
	if err != nil {
		fmt.Printf("[migrate] 用餐记录唯一索引升级失败，已整体回滚（数据与原索引保持不变）: %v\n", err)
		return
	}
	if merged > 0 {
		fmt.Printf("[migrate] 已合并 %d 组重复用餐记录（原始行备份在 meal_records_dedup_backup）并建立唯一索引\n", merged)
	}
}

// indexIsUnique 指定表上的同名索引是否已是唯一索引；索引不存在返回 false
func indexIsUnique(db *gorm.DB, table, index string) (bool, error) {
	var rows []struct {
		Name   string
		Unique int
	}
	if err := db.Raw("PRAGMA index_list(" + table + ")").Scan(&rows).Error; err != nil {
		return false, err
	}
	for _, r := range rows {
		if r.Name == index {
			return r.Unique == 1, nil
		}
	}
	return false, nil
}

// backupDuplicateMealRecords 把所有涉及重复的原始行（含将被保留的那条）复制到备份表，
// 合并结果不满意时可以据此手工恢复。列显式列出，备份表结构不随模型漂移。
func backupDuplicateMealRecords(tx *gorm.DB) error {
	if err := tx.Exec(`CREATE TABLE IF NOT EXISTS meal_records_dedup_backup (
		id integer, dish_id integer, dish_name text, meal_type text, meal_date text,
		rating integer, remark text, mood text, photo text, created_at datetime, backed_up_at datetime)`).Error; err != nil {
		return fmt.Errorf("创建备份表: %w", err)
	}
	if err := tx.Exec(`INSERT INTO meal_records_dedup_backup
		(id, dish_id, dish_name, meal_type, meal_date, rating, remark, mood, photo, created_at, backed_up_at)
		SELECT m.id, m.dish_id, m.dish_name, m.meal_type, m.meal_date, m.rating, m.remark, m.mood, m.photo, m.created_at, CURRENT_TIMESTAMP
		FROM meal_records m
		WHERE EXISTS (SELECT 1 FROM meal_records d
			WHERE d.dish_id = m.dish_id AND d.meal_type = m.meal_type AND d.meal_date = m.meal_date AND d.id <> m.id)`).Error; err != nil {
		return fmt.Errorf("备份重复记录: %w", err)
	}
	return nil
}

// mergeDuplicateMealRecords 同一 (菜, 餐次, 日期) 的多条记录合并进最早一条后删除其余
func mergeDuplicateMealRecords(tx *gorm.DB, dishID uint, mealType, mealDate string) error {
	var rows []models.MealRecord
	if err := tx.Where("dish_id = ? AND meal_type = ? AND meal_date = ?", dishID, mealType, mealDate).
		Order("id ASC").Find(&rows).Error; err != nil {
		return fmt.Errorf("读取重复记录: %w", err)
	}
	if len(rows) < 2 {
		return nil
	}
	keeper := rows[0]
	remarks := []string{}
	if r := strings.TrimSpace(keeper.Remark); r != "" {
		remarks = append(remarks, r)
	}
	ids := make([]uint, 0, len(rows)-1)
	for _, dup := range rows[1:] {
		if keeper.Rating == 0 && dup.Rating > 0 {
			keeper.Rating = dup.Rating
		}
		if keeper.Photo == "" && dup.Photo != "" {
			keeper.Photo = dup.Photo
		}
		if keeper.Mood == "" && dup.Mood != "" {
			keeper.Mood = dup.Mood
		}
		if r := strings.TrimSpace(dup.Remark); r != "" && !slices.Contains(remarks, r) {
			remarks = append(remarks, r)
		}
		ids = append(ids, dup.ID)
	}
	keeper.Remark = strings.Join(remarks, "；")
	if err := tx.Save(&keeper).Error; err != nil {
		return fmt.Errorf("保存合并结果: %w", err)
	}
	if err := tx.Delete(&models.MealRecord{}, ids).Error; err != nil {
		return fmt.Errorf("删除重复记录: %w", err)
	}
	return nil
}

func configureSQLite(db *gorm.DB) error {
	pragmas := []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA temp_store = MEMORY",
	}
	for _, pragma := range pragmas {
		if err := db.Exec(pragma).Error; err != nil {
			return err
		}
	}
	return nil
}

func seedData() {
	var count int64
	DB.Model(&models.Setting{}).Count(&count)
	if count == 0 {
		DB.Create(&models.Setting{Key: "repeat_days", Value: "3"})
		DB.Create(&models.Setting{Key: "pick_animation", Value: "wheel"})
		DB.Create(&models.Setting{Key: "blind_box_enabled", Value: "1"})
		DB.Create(&models.Setting{Key: "voice_enabled", Value: "1"})
	}

	DB.Model(&models.Quote{}).Count(&count)
	if count == 0 {
		quotes := []models.Quote{
			{Content: "中午来点硬菜，下午才有力气搬砖", Scene: "lunch"},
			{Content: "今晚吃顿好的，犒劳一下辛苦的你", Scene: "dinner"},
			{Content: "15分钟搞定，比外卖还快！", Scene: "quick"},
			{Content: "喝碗热汤，暖暖的，很贴心", Scene: "soup"},
			{Content: "你的心头好又来啦~", Scene: "favorite"},
			{Content: "今天辛苦了，吃点好的犒劳自己", Scene: "lunch"},
			{Content: "简单做做，好吃就行", Scene: "quick"},
			{Content: "换个口味，换种心情", Scene: "dinner"},
			{Content: "这道菜，吃了会开心的", Scene: "lunch"},
			{Content: "美食是最好的治愈", Scene: "dinner"},
			{Content: "尝尝这道，保准你满意", Scene: "lunch"},
			{Content: "下班了，来顿丰盛的", Scene: "dinner"},
			{Content: "好久没吃这个了吧？来一个！", Scene: "favorite"},
			{Content: "今天有点累？来道简单的", Scene: "quick"},
			{Content: "周末就该吃点好的", Scene: "dinner"},
		}
		DB.Create(&quotes)
	}

	for _, a := range achievements.DefaultAchievements() {
		var existing models.Achievement
		if err := DB.Where("code = ?", a.Code).First(&existing).Error; err == nil {
			if existing.Condition == "" || existing.Condition == "manual" {
				DB.Model(&existing).Update("condition", a.Condition)
			}
			continue
		}
		DB.Create(&a)
	}

	for _, dish := range dishes.DefaultDishes() {
		var existing models.Dish
		if err := DB.Where("name = ?", dish.Name).First(&existing).Error; err == nil {
			continue
		}
		DB.Create(&dish)
	}

	var dishesPerDayCount int64
	DB.Model(&models.Setting{}).Where("`key` = ?", "dishes_per_day").Count(&dishesPerDayCount)
	if dishesPerDayCount == 0 {
		DB.Create(&models.Setting{Key: "dishes_per_day", Value: "2"})
	}

	var lunchPerDayCount int64
	DB.Model(&models.Setting{}).Where("`key` = ?", "lunch_dishes_per_day").Count(&lunchPerDayCount)
	if lunchPerDayCount == 0 {
		DB.Create(&models.Setting{Key: "lunch_dishes_per_day", Value: "1"})
	}

	var dinnerPerDayCount int64
	DB.Model(&models.Setting{}).Where("`key` = ?", "dinner_dishes_per_day").Count(&dinnerPerDayCount)
	if dinnerPerDayCount == 0 {
		DB.Create(&models.Setting{Key: "dinner_dishes_per_day", Value: "1"})
	}

	upsertManagedStringArraySetting("categories", dishes.DefaultCategories())

	upsertStringArraySetting("tastes", dishes.DefaultTastes())
}

func jsonArrayString(values []string) string {
	data, err := json.Marshal(values)
	if err != nil {
		return "[]"
	}
	return string(data)
}

func upsertStringArraySetting(key string, defaults []string) {
	var setting models.Setting
	if err := DB.Where("`key` = ?", key).First(&setting).Error; err != nil {
		DB.Create(&models.Setting{Key: key, Value: jsonArrayString(defaults)})
		return
	}

	existing := parseStringArray(setting.Value)
	merged := appendMissingStringValues(existing, defaults)
	if !sameStringValues(existing, merged) {
		DB.Model(&models.Setting{}).Where("`key` = ?", key).Update("value", jsonArrayString(merged))
	}
}

func upsertManagedStringArraySetting(key string, defaults []string) {
	var setting models.Setting
	if err := DB.Where("`key` = ?", key).First(&setting).Error; err != nil {
		DB.Create(&models.Setting{Key: key, Value: jsonArrayString(defaults)})
		return
	}

	allowed := stringSet(defaults)
	existing := parseStringArray(setting.Value)
	managed := make([]string, 0, len(defaults))
	for _, value := range existing {
		if allowed[value] {
			managed = append(managed, value)
		}
	}
	managed = appendMissingStringValues(managed, defaults)
	if !sameStringValues(existing, managed) {
		DB.Model(&models.Setting{}).Where("`key` = ?", key).Update("value", jsonArrayString(managed))
	}
}

func parseStringArray(raw string) []string {
	var values []string
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return []string{}
	}
	return values
}

func appendMissingStringValues(existing []string, defaults []string) []string {
	seen := make(map[string]bool, len(existing)+len(defaults))
	result := make([]string, 0, len(existing)+len(defaults))
	for _, value := range existing {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	for _, value := range defaults {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func stringSet(values []string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		if value != "" {
			result[value] = true
		}
	}
	return result
}

func sameStringValues(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
