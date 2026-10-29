package database

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"
)

const backupPrefix = "ninimenu-"

// BackupFile 一份数据库备份
type BackupFile struct {
	Name    string    `json:"name"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
}

// SnapshotTo 用 VACUUM INTO 把数据库写成一个完整、一致的副本（写入期间其他请求照常读写）。
// path 必须不存在，否则 SQLite 报错。
func SnapshotTo(db *gorm.DB, path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	return db.Exec("VACUUM INTO ?", path).Error
}

// DailyBackup 今天还没有备份就做一份（ninimenu-YYYY-MM-DD.db），并只保留最新的 keep 份。
// 返回新建的文件路径；今天已备份过返回空串。清理旧备份失败（如某份正被别的程序打开）
// 只记日志，不算这次备份失败。
func DailyBackup(db *gorm.DB, dir string, keep int, now time.Time) (string, error) {
	path := filepath.Join(dir, backupPrefix+now.Format("2006-01-02")+".db")
	created := ""
	if _, err := os.Stat(path); os.IsNotExist(err) {
		// 先写临时文件再改名：写到一半进程退出，不会留下一份看起来完整、实际损坏的备份
		tmp := path + ".tmp"
		_ = os.Remove(tmp)
		if err := SnapshotTo(db, tmp); err != nil {
			_ = os.Remove(tmp)
			return "", err
		}
		if err := os.Rename(tmp, path); err != nil {
			_ = os.Remove(tmp)
			return "", err
		}
		created = path
	} else if err != nil {
		return "", err
	}
	if err := pruneBackups(dir, keep); err != nil {
		fmt.Printf("[backup] 清理旧备份失败: %v\n", err)
	}
	return created, nil
}

// ListBackups 备份目录里的数据库备份，最新的在前
func ListBackups(dir string) ([]BackupFile, error) {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return []BackupFile{}, nil
	}
	if err != nil {
		return nil, err
	}
	files := make([]BackupFile, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, backupPrefix) || !strings.HasSuffix(name, ".db") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, BackupFile{Name: name, Size: info.Size(), ModTime: info.ModTime()})
	}
	// 文件名带日期，按名字倒序即最新在前
	sort.Slice(files, func(i, j int) bool { return files[i].Name > files[j].Name })
	return files, nil
}

// pruneBackups 只保留最新的 keep 份（keep <= 0 不删）
func pruneBackups(dir string, keep int) error {
	if keep <= 0 {
		return nil
	}
	files, err := ListBackups(dir)
	if err != nil {
		return err
	}
	var firstErr error
	for _, f := range files[min(keep, len(files)):] {
		// 某一份删不掉不影响继续删其余的
		if err := os.Remove(filepath.Join(dir, f.Name)); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// StartAutoBackup 启动后立即检查一次，之后每小时检查一次：每天一份，保留最新 keep 份。
// keep <= 0 时不启动。备份失败只记日志，不影响服务。
func StartAutoBackup(dir string, keep int) {
	if keep <= 0 {
		return
	}
	run := func() {
		path, err := DailyBackup(DB, dir, keep, time.Now())
		if err != nil {
			fmt.Printf("[backup] 数据库自动备份失败: %v\n", err)
			return
		}
		if path != "" {
			fmt.Printf("[backup] 已备份数据库到 %s\n", path)
		}
	}
	go func() {
		run()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			run()
		}
	}()
}
