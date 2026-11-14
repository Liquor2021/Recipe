const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const { createElement } = require("react")
const { renderToStaticMarkup } = require("react-dom/server")

function load(relative) {
  const source = fs.readFileSync(path.join(__dirname, "..", relative), "utf8")
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, require })
  return module.exports.default
}

test("SafeImage 列表默认 lazy/async；首屏 eager 显式可选，不重复实现懒加载", () => {
  const SafeImage = load("src/components/SafeImage.tsx")
  const props = { src: "/image.png", alt: "照片", fallback: createElement("span", null, "无图") }
  assert.match(renderToStaticMarkup(createElement(SafeImage, props)), /loading="lazy"/)
  assert.match(renderToStaticMarkup(createElement(SafeImage, { ...props, eager: true })), /loading="eager"/)
  assert.match(renderToStaticMarkup(createElement(SafeImage, props)), /decoding="async"/)
  assert.equal(renderToStaticMarkup(createElement(SafeImage, { ...props, src: "" })), "<span>无图</span>")
})

function luminance(hex) {
  const c = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]
}
test("实际夜间正文和小字在纸张/卡片背景上的对比度符合 WCAG AA", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/styles/kitchen-shell.css"), "utf8")
  const block = css.slice(css.indexOf('.kitchen-shell[data-kitchen-theme="night"]')).split("}")[0]
  const colors = Object.fromEntries([...block.matchAll(/--k-(\w+):\s*(#[0-9a-f]{6})/g)].map(m => [m[1], m[2]]))
  for (const text of ["ink", "muted", "faint"]) for (const surface of ["paper", "card"]) {
    const a = luminance(colors[text]), b = luminance(colors[surface])
    assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 4.5, `${text}/${surface}`)
  }
})

test("虚拟列表保留动态行高测量，不盲加跳过渲染；GSAP 保留 CSS 动画入口", () => {
  const dishes = fs.readFileSync(path.join(__dirname, "../src/pages/DishList.tsx"), "utf8")
  assert.match(dishes, /useVirtualizer/)
  assert.match(dishes, /measureElement/)
  const css = fs.readFileSync(path.join(__dirname, "../src/styles/kitchen-dishes.css"), "utf8")
  assert.doesNotMatch(css, /content-visibility\s*:/)
  const gsap = fs.readFileSync(path.join(__dirname, "../src/lib/gsap.ts"), "utf8")
  assert.match(gsap, /import gsap from "gsap"/)
  assert.doesNotMatch(gsap, /from "gsap\/(Flip|ScrollToPlugin)"/)
})
