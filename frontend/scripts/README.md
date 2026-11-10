# 前端逻辑回归

`.mjs` 和 `.cjs` 都是由 Node.js 执行的 JavaScript 文件，分别使用 ES 模块和 CommonJS 模块格式。这些脚本用于检查功能，不会打进网页资源，也不需要浏览器或数据库。

在 `frontend` 目录运行：

```sh
node --test scripts/*.test.*
```

使用支持原生 TypeScript 类型移除的 Node.js（本项目验证环境为 Node.js 24），并先安装前端项目依赖。

| 脚本 | 验证内容 |
| --- | --- |
| `tomorrow-draft.test.mjs` | 明日菜单草稿往返、空菜单、保存基线、取消/改期/份量变化时保留冲突草稿、跨日与异常存储 |
| `tomorrow-requests.test.mjs` | 推荐请求乱序、手动选菜或修改数量后丢弃旧响应、离页隔离、重新挂载与冲突响应识别 |
| `tomorrow-recommendations.test.mjs` | 单道替换、整餐换菜与重新生成的当前菜排除、最近换菜历史、候选不足与重复响应处理 |
| `tomorrow-date.test.mjs` | 本地午夜切换、跨月/跨年/闰日，以及夏令时 23/25 小时日期的刷新时间 |
| `home-mood.test.mjs` | 心情异步恢复、快速点选、失败回退与跨日隔离 |
| `history-summary.test.mjs` | 计划相对日期、跨月/跨年/闰日/夏令时、月度顿数与道数区分、状态和月份过滤、分页重复去重 |
| `fridge-filters.test.mjs` | 同名多批筛选、名称搜索、临期边界、无效日期与跨日更新 |
| `auth-regression.test.cjs` | 管理员与应用认证分离、状态同步、登录失败和迟到的旧请求；普通读取接受离线副本、编辑读取拒绝旧 Service Worker 缓存 |
| `login-error.test.mjs` | 应用与管理登录区分密码错误、断网、超时、限流和服务故障；仅密码错误标记输入无效 |
| `cook-timer.test.mjs` | 做菜倒计时延迟纠偏、暂停继续、总进度保持、到时与重置边界 |
| `dish-editor-session.test.mjs` | 编辑器上传乱序、替换失败、离开页面隔离、上传与保存互斥、服务器版本识别 |
| `meal-selection.test.mjs` | 点菜请求互斥、跨页面等待、不同菜独立更新、失败恢复与并发刷新交接 |
| `list-scroll.test.mjs` | 列表返回位置、隐藏容器等待布局、缓存失效后的分页补齐、结果缩短及滚动赋值失败 |
| `dish-virtual.test.mjs` | 虚拟行分组与稳定键、分页插入、动态行高快照恢复、键盘焦点跨渲染边界 |

逻辑测试直接导入 TypeScript helper；认证测试使用项目已安装的 TypeScript 编译并加载实际客户端源码，模拟网络和存储。所有测试均不读写真实用户数据。

只检查明日菜单的草稿与请求状态时，在 `frontend` 目录运行：

```sh
node --test scripts/tomorrow-draft.test.mjs scripts/tomorrow-requests.test.mjs scripts/tomorrow-date.test.mjs
```

这些测试覆盖状态逻辑，不会打开页面。明日菜单的数据库版本核对、事务回滚和重复请求处理由后端 Go 测试覆盖；提示内容、重试按钮和跨日页面切换仍需浏览器验证。后端接口脚本的启动方式见 `backend/scripts_test/README.md`。
