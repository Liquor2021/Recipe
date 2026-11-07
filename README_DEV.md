# NiniMenu 开发指南

## 环境要求

- Go 1.25+
- Node.js 20+
- Python 3.10+（图片工具脚本）
- uv（Python 包管理）

## 后端开发

```bash
cd backend
go run cmd/server/main.go
```

默认运行在 `http://localhost:8080`。

## 前端开发

```bash
cd frontend
npm install
npm run dev
```

Vite 开发服务器默认 `http://localhost:5173`，自动代理 API 到后端。

## 构建发布

### Windows

```bat
build_windows.bat
```

输出到 `dist-win/`，运行 `dist-win\ninimenu.exe`。

### Linux

```bat
build_linux.bat
```

输出 `ninimenu-linux-amd64.tar.gz`，部署：

```bash
tar -xzf ninimenu-linux-amd64.tar.gz -C /opt/ninimenu
chmod +x ninimenu
./ninimenu
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | 服务端口 |
| `APP_PASSWORD` | `nini123` | 应用端密码 |
| `ADMIN_PASSWORD` | `nini123` | 管理端密码 |
| `JWT_SECRET` | `ninimenu-secret-key` | JWT 签名密钥 |
| `JWT_EXPIRE` | `24h` | Token 过期时间 |
| `DB_PATH` | `data/ninimenu.db` | 数据库路径 |
| `UPLOAD_DIR` | `uploads` | 上传目录（压缩后的图片） |
| `BACKUP_DIR` | `uploads_backup` | 上传原图备份目录 |
| `MAX_UPLOAD_SIZE_MB` | `5` | 上传文件大小上限（MB） |
| `COMPRESS_MAX_DIM` | `1200` | 图片压缩最大宽高（px） |
| `JPEG_QUALITY` | `85` | JPG 压缩质量（1-100） |
| `REPEAT_DAYS` | `3` | 推荐去重天数 |
| `DB_BACKUP_DIR` | 数据库同目录下的 `backups/` | 数据库每日自动备份目录 |
| `DB_BACKUP_KEEP` | `7` | 自动备份保留份数，`0` 关闭自动备份 |

可写入项目根目录 `.env` 文件，运行时自动加载。发布包中使用 `env.bak`。

`APP_PASSWORD`、`ADMIN_PASSWORD`、`JWT_SECRET` 的默认值是公开的，只适合本机试用；仍是默认值时，启动日志和管理后台会给出提醒。部署到局域网或公网前务必改掉，尤其是 `JWT_SECRET`：用默认值时，知道它的人可以自己签发管理端登录凭证。

## 数据库备份与恢复

服务运行时每天自动用 `VACUUM INTO` 备份一次数据库（`ninimenu-YYYY-MM-DD.db`），只保留最新 `DB_BACKUP_KEEP` 份；管理后台「设置 → 数据备份」可以查看备份并下载一份当前数据库。备份只含数据库，上传的图片原图在 `BACKUP_DIR`。

恢复：停止服务 → 把 `data/ninimenu.db` 换成要恢复的备份文件（同时删掉旁边的 `ninimenu.db-wal`、`ninimenu.db-shm`）→ 启动服务。

## 上传图片压缩机制

手机上传的截图和照片通常是体积很大的 PNG 格式。系统在上传时自动处理：

1. **原图备份** — 原始文件保存到 `BACKUP_DIR`（默认 `uploads_backup/YYYY/MM/DD/`）
2. **压缩转换** — EXIF 方向修正 + 缩放（不超过 `COMPRESS_MAX_DIM`）+ 转 JPG（`JPEG_QUALITY` 质量）
3. **返回压缩 URL** — 前端拿到的是压缩后的 JPG 路径
4. **容错回退** — 如果压缩失败，自动使用原图

PNG 截图转 JPG quality=85 通常减少 70-90% 体积，视觉几乎无损。

列表缩略图：菜品列表、记录、照片墙等小图请求 `/thumbs/<路径>`（对应 `/uploads/<路径>`）。后端第一次收到请求时按原图生成短边 400px 的 JPG，缓存在 `UPLOAD_DIR/_thumbs/`，原图更新后自动重新生成；原图本来就小或生成失败时直接返回原图。种子菜谱的图片一页约 1.7MB，换成缩略图后约 0.8MB。`_thumbs/` 可以随时删掉，会按需重新生成；构建脚本复制 uploads 时会跳过它。

相关代码：
- 压缩核心：`backend/internal/imaging/compress.go`
- 上传处理：`backend/internal/handlers/upload.go`
- 缩略图：`backend/internal/handlers/thumb.go`
- 配置项：`backend/internal/config/config.go`

上传失败时前端会展示后端返回的具体错误信息（如"图片大小不能超过5MB"），而非通用提示。

## 图片工具脚本

脚本依赖 `openai` 和 `pillow`，安装：

```bash
uv sync
```

### 单张生成

```bash
uv run python scripts/generate_dish_image.py --prompt "菜品为番茄炒蛋 将宽高比设为 1:1" --output tomato_egg.png
```

### 批量生成

编辑 `dish_images.txt`，格式为 `菜品名 输出路径`，然后：

```bash
uv run python scripts/generate_dish_images_batch.py --input dish_images.txt --output-root output
```

支持 `--submit-only`（仅提交请求）和 `--recover-history`（从历史记录下载）模式。

### 图片压缩（离线批量处理）

```bash
uv run python scripts/compress_upload_images.py --input-dir output/uploads --auto-quality
```

> 这是离线批量脚本，用于压缩预生成的菜品图片。运行时上传压缩由 Go 后端自动完成。

## Go 图片处理依赖

| 包 | 用途 |
|----|------|
| `github.com/disintegration/imaging` | 图片缩放、EXIF 方向修正、Lanczos 重采样 |
| `golang.org/x/image/webp` | WebP 格式解码（间接依赖，用于上传兼容） |
| `image/jpeg`（标准库） | JPG 编码 |
| `image/draw`（标准库） | 透明图层合成白底 |

## 项目结构

```
NiniMenu/
├── backend/                    # Go 后端
│   ├── cmd/
│   │   ├── server/main.go      # 服务入口
│   │   └── imgtool/main.go     # 图片处理工具源码（白边去除 & 多尺寸图标生成）
│   ├── internal/
│   │   ├── config/             # 环境变量配置
│   │   ├── database/           # 数据库初始化 & 种子数据
│   │   ├── handlers/           # HTTP 处理器
│   │   ├── imaging/            # 图片压缩处理（EXIF 修正 + 缩放 + JPG 编码）
│   │   ├── middleware/         # CORS, JWT, 日志中间件
│   │   ├── models/             # 数据模型
│   │   ├── routes/             # 路由注册
│   │   ├── services/           # 业务逻辑（推荐算法, 成就引擎, 周计划）
│   │   ├── dishes/             # 菜品种子数据包
│   │   ├── achievements/       # 成就目录
│   │   └── utils/              # 工具函数
│   ├── imgtool.exe             # 图片白边去除 & 多尺寸图标生成工具
│   ├── data/                   # SQLite 数据库
│   ├── uploads/                # 用户上传图片（压缩后的 JPG）
│   ├── uploads_backup/         # 用户上传原图备份
│   └── static/                 # 前端构建产物
├── frontend/                   # React 前端
│   ├── src/
│   │   ├── pages/              # 页面组件
│   │   ├── components/         # 通用组件
│   │   ├── layouts/            # 布局组件
│   │   ├── store/              # Zustand 状态
│   │   ├── types/              # TypeScript 类型
│   │   └── api/                # API 封装（含上传错误信息提取）
│   └── public/                 # 静态资源 & PWA 图标
├── scripts/                    # Python 图片工具脚本
├── build_windows.bat           # Windows 构建脚本
├── build_linux.bat             # Linux 构建脚本
├── pyproject.toml              # Python 脚本依赖
└── .env                        # 本地环境变量
```

## API 概览

### 公开接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/app/login` | 应用端密码登录 |
| POST | `/api/admin/login` | 管理端密码登录 |
| GET | `/api/app-info` | 应用信息（名称等） |

### 应用接口（需 App Token 或 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/dishes` | 菜品列表 |
| GET | `/api/dishes/:id` | 菜品详情 |
| GET | `/api/dishes/:id/records` | 菜品用餐记录 |
| GET/POST/PUT/DELETE | `/api/records` | 用餐记录 CRUD |
| POST | `/api/records/batch` | 批量创建记录 |
| GET | `/api/records/:id` | 读取单条计划/用餐记录及保存份量 |
| GET/PUT | `/api/meal-plans/:date` | 读取或原子保存明日菜单；PUT 携带 `expected_version`、`request_id`、`dishes`，版本冲突返回 409 并保留客户端草稿供核对 |
| GET/POST | `/api/favorites/:dishId` | 收藏/取消收藏 |
| POST | `/api/pick/lunch\|dinner\|mood\|tomorrow\|blind-box` | 各类推荐 |
| GET/POST | `/api/day-rating` | 每日评价；GET 返回含 `version` 的快照（未创建也返回空快照），POST 必须携带 `expected_version`，版本缺失或变化返回 409 |
| GET | `/api/day-ratings` | 按 `date_from`、`date_to` 读取每日评价，各条含 `version`；读取失败返回 500 |
| POST | `/api/day-rating/home-mood` | 独立更新首页心情，传 `meal_date` 与 `home_mood`；不改变整体评价的版本 |
| GET | `/api/photo-wall` | 照片墙 |
| GET/POST | `/api/shopping-list` | 购物清单 |
| POST | `/api/shopping-list/toggle` | 勾选/取消已买，携带对应食材的 `demand_version`；版本缺失或清单变化返回 409，须重新读取并核对 |
| POST | `/api/shopping-list/inventory` | 标记或取消“家中有”；取消时携带当前清单的 `inventory_version`，版本缺失或可用批次、数量、保质期、日期变化返回 409；核对后才移出对应未过期批次 |
| POST | `/api/shopping-list/items` | 补料，传 `items` 及可选 `dish_id`、`dish_name`；缺失用量按菜谱补齐，菜谱读取故障返回 500 且本次不写入任何补料项 |
| GET | `/api/week-plan` | 周计划 |
| POST | `/api/week-plan/regenerate` | 重新生成周菜单，成功响应为已保存的完整菜单；读写失败返回 500 |
| POST | `/api/week-plan/swap` | 周计划只换一道菜（`{date, meal_type, dish_id}`；菜单已变化返回 409） |
| GET | `/api/achievements` | 成就列表 |
| GET | `/api/stats` | 统计数据 |

每日评价的版本覆盖日期、整体心情、备注和照片，不包含首页心情。提交只更新显式提供的字段；例如仅提交 `photos` 不会清空备注。服务端在同一事务内核对版本并保存。客户端打开编辑器和失败后核对时使用实时读取，拒绝离线缓存；409 或保存结果未确认时保留草稿，展示最新内容供选择，不自动重放旧请求。删除当天照片同样携带用户实际看到的快照版本，失败后先重读，再由用户重新确认目标。

### 管理接口（需 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| CRUD | `/api/dishes` | 菜品管理 |
| POST | `/api/dishes/batch-*` | 批量操作 |
| POST | `/api/upload/image` | 图片上传（自动备份+压缩） |
| DELETE | `/api/upload/image` | 图片删除 |
| CRUD | `/api/quotes` | 语录管理 |
| CRUD | `/api/achievements` | 成就管理 |
| PUT | `/api/settings` | 系统设置（请求体须包裹为 `{"settings":{"key":"value"}}`，扁平键值体会被 400 拒绝） |
| GET | `/api/admin/dashboard` | 仪表盘 |

## 回归测试

编辑基线统一通过 `apiFresh` 读取：请求带 `X-Nini-Require-Fresh: 1`，Service Worker 不允许离线回退；客户端同时拒绝带 `sw-cached-at` 的响应，兼容仍运行旧版 Service Worker 的设备。普通浏览使用 `api`，仍支持有效期内的离线副本。管理页使用独立的 `admin` 查询键，避免与普通浏览缓存混用。菜品启用切换在事务内仅原子翻转 `enabled`，随后读取结果；菜谱编辑也只更新表单拥有的字段，保留并发启停、收藏与软删除状态。上线时需同步更新前后端；旧页面缺少版本字段的写入会被拒绝，应刷新页面再核对操作。

- 后端单元与接口处理器测试：在 `backend` 目录运行 `go test ./...`，测试使用各自创建的临时数据库。
- HTTP 接口回归脚本：见 `backend/scripts_test/README.md`，需要启动使用独立临时数据库的服务，脚本会修改测试数据。
- 前端状态逻辑测试：使用支持原生 TypeScript 类型移除的 Node.js（验证环境为 Node.js 24），安装前端依赖后于 `frontend` 目录运行 `node --test scripts/*.test.*`；详见 `frontend/scripts/README.md`。

`.mjs` 表示 JavaScript ES 模块脚本，`.cjs` 表示 CommonJS 模块脚本；本项目这些测试文件由 Node.js 执行，不是应用启动入口，也不会被打包进网页。逻辑与接口测试不能代替浏览器中的点击、布局和手机验证。
