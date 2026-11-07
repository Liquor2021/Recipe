# Kitchen Serif 标题字体

字体为 Google Fonts 的 Noto Serif SC，采用 SIL Open Font License 1.1；完整版权及许可见 `OFL-NotoSerifSC.txt`。`Kitchen Serif` 仅为 CSS 使用的 family 别名，未修改字体名称或字形设计。

- 官方源仓库：https://github.com/google/fonts/tree/main/ofl/notoserifsc
- 官方分发：Google Fonts CSS API / fonts.gstatic.com，下载日期 2026-11-08。
- 字重：700–900 可变字重；仅用于手账主题标题、菜名与操作文字，正文继续使用系统无衬线字体。
- 本地文件不依赖运行时外网请求。`kitchen-serif-ui.woff2` 包含首页和导航文字、常用标点及 Latin 字符；其余文件包含全部内置种子菜谱文本所需的其余中文字，按互不重叠的 `unicode-range` 按需加载。
- 原始请求地址、字体分发地址和文件大小记录于 `kitchen-serif-sources.json`。子集由 Google Fonts 的 `text=` 参数直接生成，无额外字体加工。
- 用户自定义内容中不在子集内的字，由 CSS 声明的宋体/serif 回退字体显示。若以后增加页面固定文案，应检查覆盖范围并更新相应子集。

引入 `frontend/src/styles/kitchen-fonts.css` 后使用 `font-family: "Kitchen Serif", "Songti SC", SimSun, serif`。字体通过 `font-display: swap` 保持首屏文字可见。
