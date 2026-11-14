// 生命周期与恢复按钮的单元回归；真实 React 捕获和页面隔离另由内置浏览器验证。
const { test } = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const ts = require("typescript")
const { createElement } = require("react")
const { renderToStaticMarkup } = require("react-dom/server")

function setup(props = {}, storage = "day") {
  const calls = []
  const source = fs.readFileSync(path.join(__dirname, "../src/components/ErrorBoundary.tsx"), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (name) => name.endsWith(".css") ? {} : require(name),
    window: {
      localStorage: { getItem: () => { if (storage instanceof Error) throw storage; return storage } },
      matchMedia: () => ({ matches: true }),
      location: { assign: (url) => calls.push(["home", url]), reload: () => calls.push(["reload"]) },
    },
    console: { error: (...args) => calls.push(["error", ...args]) },
  })
  const Boundary = module.exports.default
  const child = createElement("p", null, "正常页面")
  const boundary = new Boundary({ children: child, ...props })
  // 此处仅模拟 React 提交状态，实际 render/effect/lazy 异常捕获须在浏览器验证。
  boundary.setState = (patch) => { boundary.state = { ...boundary.state, ...patch } }
  const crash = () => { boundary.state = { ...boundary.state, ...Boundary.getDerivedStateFromError() } }
  return { Boundary, boundary, child, calls, crash }
}

function button(element, text) {
  if (!element || typeof element !== "object") return undefined
  if (element.type === "button" && element.props.children === text) return element
  for (const child of [element.props?.children].flat()) {
    const found = button(child, text)
    if (found) return found
  }
}

test("健康页面原样返回，不引入额外挂载和包装节点", () => {
  const { boundary, child } = setup()
  assert.equal(boundary.render(), child)
})

test("异常后提供重试、回首页和刷新，不把技术错误暴露给用户", () => {
  const { boundary, calls, crash } = setup()
  crash()
  const error = new Error("私有业务字段 secret")
  boundary.componentDidCatch(error, { componentStack: "\n at BrokenPage" })
  const markup = renderToStaticMarkup(boundary.render())
  assert.match(markup, /role="alert"/)
  for (const label of ["这页暂时出错了", "重试", "回首页", "刷新页面"]) assert.ok(markup.includes(label))
  assert.ok(!markup.includes("secret"))
  assert.equal(calls[0][2], error)
  assert.equal(calls[0][3], "\n at BrokenPage")
})

test("重试仅清除错误状态；持续异常再次兜底而不无限自动重试", () => {
  const { boundary, child, crash } = setup({ resetKey: "route-1" })
  crash()
  button(boundary.render(), "重试").props.onClick()
  assert.equal(boundary.render(), child)
  assert.equal(boundary.state.resetKey, "route-1")
  crash()
  assert.ok(button(boundary.render(), "重试"))
})

test("页面回首页使用路由回调，不强制刷新其他健康页面", () => {
  let navigated = false
  const { boundary, calls, crash } = setup({ onGoHome: () => { navigated = true } })
  crash()
  button(boundary.render(), "回首页").props.onClick()
  assert.equal(navigated, true)
  assert.equal(calls.length, 0)
})

test("根边界不依赖路由，也能回首页和完整刷新 lazy 模块", () => {
  const { boundary, calls, crash } = setup({ fullScreen: true })
  crash()
  const fallback = boundary.render()
  assert.match(fallback.props.className, /kitchen-error-screen/)
  button(fallback, "回首页").props.onClick()
  button(fallback, "仍有问题？刷新页面").props.onClick()
  assert.deepEqual(calls, [["home", "/"], ["reload"]])
})

test("路径改变清除兜底，健康路由和同一路由重渲染不被重挂", () => {
  const { Boundary, boundary, child, crash } = setup({ resetKey: "route-1" })
  crash()
  assert.equal(Boundary.getDerivedStateFromProps({ resetKey: "route-1" }, boundary.state), null)
  const next = Boundary.getDerivedStateFromProps({ resetKey: "route-2" }, boundary.state)
  boundary.state = { ...boundary.state, ...next }
  assert.equal(boundary.render(), child)
  assert.equal(boundary.state.resetKey, "route-2")
  assert.equal(Boundary.getDerivedStateFromProps({ resetKey: "route-2" }, boundary.state), null)
})

test("全屏兜底支持夜间与不可用存储，局部兜底继承布局主题", () => {
  for (const storage of ["night", new Error("SecurityError"), null, "旧主题"]) {
    const { boundary, crash } = setup({ fullScreen: true }, storage)
    crash()
    assert.match(boundary.render().props.className, /kitchen-night/)
  }
  const { boundary, crash } = setup({}, "night")
  crash()
  assert.equal(boundary.render().props.className, "kitchen-error")
})

// 检查接线而非复制实现：根、每个常驻页签、普通/管理子页都必须位于边界内。
function sourceTree(file) {
  return ts.createSourceFile(file, fs.readFileSync(path.join(__dirname, "..", file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
function wrapped(tree, childName, boundaryName) {
  let found = false
  function visit(node, ancestors = []) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === childName) {
      found ||= ancestors.includes(boundaryName)
    }
    const next = ts.isJsxElement(node) ? [...ancestors, node.openingElement.tagName.getText(tree)] : ancestors
    ts.forEachChild(node, (child) => visit(child, next))
  }
  visit(tree)
  return found
}

test("根与常驻页签逐页隔离；子页和管理页 Outlet 就地隔离", () => {
  for (const [file, child, parent] of [
    ["src/main.tsx", "App", "ErrorBoundary"],
    ["src/layouts/MainLayout.tsx", "tab.Component", "ErrorBoundary"],
    ["src/layouts/SubPageLayout.tsx", "Outlet", "RouteErrorBoundary"],
    ["src/layouts/AdminLayout.tsx", "Outlet", "RouteErrorBoundary"],
    ["src/App.tsx", "CookMode", "RouteErrorBoundary"],
  ]) assert.ok(wrapped(sourceTree(file), child, parent), `${file}: ${child} 需要在 ${parent} 内`)
})

test("路由恢复使用 resetKey 而非 React key，避免每次导航重挂整站", () => {
  const tree = sourceTree("src/components/RouteErrorBoundary.tsx")
  let checked = false
  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(tree) === "ErrorBoundary") {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
      const resetKey = attrs.find((attr) => attr.name.getText(tree) === "resetKey")
      assert.equal(resetKey.initializer.expression.getText(tree), "location.key")
      assert.ok(!attrs.some((attr) => attr.name.getText(tree) === "key"))
      checked = true
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.equal(checked, true)
})
