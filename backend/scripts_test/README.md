# 接口回归脚本

`.mjs` 是 JavaScript 的 ES Module 文件，用 Node.js 运行。这里的脚本通过 HTTP 调用后端并检查返回结果；它们不参与网站页面打包，也不是运行应用所必需的文件。

`E2E` 表示端到端测试。这里主要覆盖接口到数据库的完整链路；按钮布局、触屏操作和 Safari 表现还需要浏览器验证。脚本里的每个 `check` 对应一项检查，失败时退出码为 1，方便自动化发现回归。

| 文件 | 验证范围 |
| --- | --- |
| `fridge_e2e.mjs` | 库存增删、多批次、推荐匹配 |
| `features_e2e.mjs` | 临期提醒、食材搜索、饮食报告、家庭忌口 |
| `features2_e2e.mjs` | 买菜入库、计划与统计、数据库备份 |
| `verify_batches.mjs` | 批次管理和扣库存 |
| `verify_review_fixes.mjs` | 精确扣减、补料、取消“家中有”的库存版本保护、评分、严格忌口与菜单缓存 |
| `features3_e2e.mjs` | 单道换菜、真实库存名、荤素统计及相关修复 |
| `meal_status_portions_e2e.mjs` | 计划完成/取消/恢复、份量、买菜数量、库存建议及统计联动 |
| `meal_followup_e2e.mjs` | 购物状态保留、计划改期与分页、扣减日志、补扣/撤销及并发版本保护 |
| `fridge_reliability_e2e.mjs` | 库存编辑版本冲突、并发写入、过期清理重新核验、旧客户端拒绝及批量回滚 |

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
$env:APP_PASSWORD = '123456'
$env:ADMIN_PASSWORD = '123456'
$env:JWT_SECRET = 'ninimenu-secret-key'
& (Join-Path $testDir 'server.exe')
```

上面的默认口令仅供本机测试，备份/默认口令检查也以此为前提。第二个窗口从项目根目录执行：

```powershell
$suites = 'fridge_e2e', 'features_e2e', 'features2_e2e', 'verify_batches', 'verify_review_fixes', 'features3_e2e', 'meal_status_portions_e2e', 'meal_followup_e2e', 'fridge_reliability_e2e'
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
- 同菜、同餐、同日只保留一条记录。完成已有计划沿用其 ID；取消只软隐藏对应买菜项，恢复沿用原量快照和采购状态，实际库存不变。
- 计划改期使用 `PUT /records/:id` 的 `meal_date` 和 `meal_type`；只有待完成计划可以改到今天或未来，目标槽位冲突时整体回滚。
- 用餐扣减使用 `POST /records/:id/consumption`，携带 `batch_ids`、`remaining` 与每个批次的 `expected_batches`（`batch_id / quantity / updated_at`）。先通过库存候选或列表获取版本，旧页面提交不会覆盖新库存。
- 扣减日志通过 `GET /records/:id/consumption` 读取。撤销扣减向 `/records/:id/consumption/undo` 提交 `{entry_id: 活动日志ID}`；撤销已吃向 `/records/:id/undo-completion` 提交同样字段，无活动日志时显式传 `null`。旧日志不能撤销新的扣减。
- `inventory_applied` 仅代表此记录存在当前有效的新扣减日志。升级前的手动扣库存无法追溯，不自动补扣或还原。
- 旧库迁移与事务回滚由 Go 测试覆盖：在 `backend` 目录运行 `go test ./...`。
- 编辑单批库存 `PUT /fridge/batch/:id` 必须携带 `expected_batch`（`batch_id / quantity / updated_at`）；旧批量入口 `/fridge/consume` 同样必须携带 `expected_batches`。缺少或过期的版本返回 409，不会覆盖最新库存。
- 清理过期使用 `POST /fridge/clear-expired`，提交 `{batch_ids: [...]}`（最多 100 批）。服务端重新核对当前日期，返回实际 `removed` 和跳过的 `skipped`，不会删除用户选中范围之外的批次。
- 勾选或取消已买使用 `POST /shopping-list/toggle`，除原有字段外必须携带当前 `GET /shopping-list` 对应食材的 `demand_version`。数量、来源记录或采购状态已变化，以及缺少版本的旧客户端均返回 409；重新读取清单并核对后再提交，不要直接重放旧版本。本目录涉及勾选的通用回归脚本会先取当前版本。
- 取消“家中有”使用 `POST /shopping-list/inventory`，提交 `{item_name, in_stock: false, inventory_version}`；版本与当前清单展示的可用批次数来自同一次读取，真别名共享版本。新增或移除批次、数量或保质期变化、跨日，以及未带版本的旧客户端均返回 409，原库存保持不变。重新读取并核对后才可再次提交；已过期批次不在移出范围内。标记 `in_stock: true` 沿用原有约定，无需库存版本。
- 补料 `POST /shopping-list/items` 会按 `dish_id` 补齐未填的菜谱用量；菜谱查询故障返回 500，本次新增项全部不写入，恢复后可重试。未指定菜品或菜品不存在时仍允许手动补料，不把正常缺失误判成数据库故障。
- 明日菜单通过 `GET /meal-plans/:date` 取得完整 `records` 和 `version`，再向 `PUT /meal-plans/:date` 提交 `{expected_version, request_id, dishes: [{dish_id, meal_type}]}`。保存只接受明天的日期；每餐最多 5 道，清空菜单显式传空数组。基线不一致返回 409，应保留草稿供用户核对。请求结果未确认时，重试同一请求应沿用原 `request_id`、版本和菜品列表。
- 周菜单重新生成和单道替换只有落库成功才返回新菜单；数据库读取或保存失败返回 500。真正没有可用菜品仍是成功的空菜单，不应与读取失败混淆。

## Go 与前端逻辑测试的范围

本轮新增的数据库故障、旧版本拒绝和事务回滚检查使用临时测试库，不要求先启动 HTTP 服务。在 `backend` 目录执行：

```sh
go test ./internal/services ./internal/handlers -count=1
```

| Go 测试文件 | 验证范围 |
| --- | --- |
| `internal/handlers/meal_plan_test.go` | 明日菜单保存基线、保留和恢复记录、购物联动回滚、响应丢失后的重复请求与并发保存 |
| `internal/services/week_plan_failure_test.go`、`internal/handlers/week_plan_test.go` | 周菜单读写失败、保留旧缓存、恢复后重试、清空内存后从数据库读回及接口错误 |
| `internal/services/shopping_expectation_test.go`、`internal/handlers/shopping_expectation_test.go` | 购物需求版本、旧勾选或取消勾选被拒绝、刷新版本后重试 |
| `internal/services/inventory_expectation_test.go`、`internal/handlers/inventory_expectation_test.go` | 取消“家中有”的别名和版本核对、旧批次确认拒绝、并发删除与回滚，以及补料菜谱读取失败零写入和恢复重试 |
| `internal/handlers/settings_read_test.go` | 设置读取错误返回失败，不返回空设置冒充成功 |

前端 `scripts/*.test.mjs` 是直接测试状态处理函数的 Node.js 脚本，不通过后端 HTTP，也不检查布局；运行方式和各脚本范围见 `frontend/scripts/README.md`。其中 `tomorrow-draft.test.mjs` 检查草稿保留与版本冲突，`tomorrow-requests.test.mjs` 检查推荐请求乱序及离页隔离。后台删除后的错误提示、末页回退、设置读取失败后的按钮禁用等页面行为仍需浏览器验证。
