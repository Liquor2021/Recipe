# 接口回归脚本

`.mjs` 是 JavaScript 的 ES Module 文件，用 Node.js 运行。这里的脚本通过 HTTP 调用后端并检查返回结果；它们不参与网站页面打包，也不是运行应用所必需的文件。

`E2E` 表示端到端测试。这里主要覆盖接口到数据库的完整链路；按钮布局、触屏操作和 Safari 表现还需要浏览器验证。脚本里的每个 `check` 对应一项检查，失败时退出码为 1，方便自动化发现回归。

| 文件 | 验证范围 |
| --- | --- |
| `fridge_e2e.mjs` | 库存增删、多批次、推荐匹配 |
| `features_e2e.mjs` | 临期提醒、食材搜索、饮食报告、家庭忌口 |
| `features2_e2e.mjs` | 买菜入库、计划与统计、数据库备份 |
| `verify_batches.mjs` | 批次管理和扣库存 |
| `verify_review_fixes.mjs` | 精确扣减、补料、评分、严格忌口与菜单缓存 |
| `features3_e2e.mjs` | 单道换菜、真实库存名、荤素统计及相关修复 |
| `meal_status_portions_e2e.mjs` | 计划完成/取消/恢复、份量、买菜数量、库存建议及统计联动 |

其余 `verify_*.mjs` 是专项诊断脚本，部分包含当时的数据或日期，不应把它们的结果直接当成通用回归结论。

## 在临时数据库运行

这些脚本会修改数据，部分还会清理库存、修改设置、解锁成就。即使脚本最后有清理，也不能保证恢复所有原始信息，必须使用专门的临时数据库。

在第一个 PowerShell 窗口，从项目根目录执行（8080 端口应空闲）：

```powershell
$testDir = Join-Path $env:TEMP ("ninimenu-tests-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testDir | Out-Null
Set-Location backend
go build -o (Join-Path $testDir 'server.exe') ./cmd/server
if ($LASTEXITCODE -ne 0) { throw '后端构建失败' }
$env:DB_PATH = Join-Path $testDir 'test.db'
$env:UPLOAD_DIR = Join-Path $testDir 'uploads'
$env:BACKUP_DIR = Join-Path $testDir 'uploads_backup'
$env:DB_BACKUP_DIR = Join-Path $testDir 'backups'
$env:DB_BACKUP_KEEP = '7'
$env:PORT = '8080'
$env:APP_PASSWORD = 'nini123'
$env:ADMIN_PASSWORD = 'nini123'
$env:JWT_SECRET = 'ninimenu-secret-key'
& (Join-Path $testDir 'server.exe')
```

上面的默认口令仅供本机测试，备份/默认口令检查也以此为前提。第二个窗口从项目根目录执行：

```powershell
$suites = 'fridge_e2e', 'features_e2e', 'features2_e2e', 'verify_batches', 'verify_review_fixes', 'features3_e2e', 'meal_status_portions_e2e'
foreach ($suite in $suites) {
    node "backend/scripts_test/$suite.mjs"
    if ($LASTEXITCODE -ne 0) { throw "$suite 验证失败" }
}
```

按顺序运行，避免多个脚本同时修改同一测试库。结束后在第一个窗口按 Ctrl+C 停止服务。

## 新记录的约定

- `status`：`planned` 计划、`completed` 已吃、`cancelled` 已取消。新建省略时为计划，日期过去不会自动完成；测试已吃统计时必须显式传 `completed`。
- `portion_scale`：相对菜谱原量的倍数，默认 1，允许 0.5–8；不是人数。省略时新记录用 1，完成或恢复已有记录时沿用已保存份量。
- 数字用量按倍数缩放；“适量”、范围、分数和组合用量保留原文。库存单位相同时才计算剩余量建议。
- 同菜、同餐、同日只保留一条记录。完成已有计划沿用其 ID；取消会移除对应买菜项，实际库存不变。
- 旧库迁移与事务回滚由 Go 测试覆盖：在 `backend` 目录运行 `go test ./...`。
