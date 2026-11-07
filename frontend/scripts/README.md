# 前端逻辑回归

`.mjs` 是由 Node.js 执行的 JavaScript 模块。这些脚本用于检查功能，不会打进网页资源，也不需要浏览器或数据库。

在 `frontend` 目录运行：

```sh
node --test scripts/tomorrow-draft.test.mjs
```

测试直接导入 TypeScript helper，使用支持原生 TypeScript 类型移除的 Node.js（本项目验证环境为 Node.js 24）。

`tomorrow-draft.test.mjs` 覆盖明日菜单草稿的详情往返、空菜单、保存基线、取消/改期/份量变化冲突、日期失效以及存储损坏或不可用。它使用内存模拟存储，不读写真实用户数据。
