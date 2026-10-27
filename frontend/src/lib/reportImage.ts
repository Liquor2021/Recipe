// 报告分享长图：用原生 canvas 2D 绘制竖版海报，配色与 app 主题（src/index.css @theme）一致
import type { DietReport, ReportShare, ReportTopDish } from "@/types"

// 逻辑宽度 750，实际输出按 DPR=2 放大（canvas 位图宽 1500px）
const WIDTH = 750
const DPR = 2

// 配色（与 index.css @theme 一致）
const C = {
  bg: "#FAFAF8",
  card: "#FFFFFF",
  primary: "#E8734A",
  mint: "#6EC6B8",
  text: "#1A1A2E",
  text2: "#6B7280",
  text3: "#9CA3AF",
  border: "#F0F0EC",
  ratingGold: "#C8A23C",
} as const

// 中文字体用系统栈，与 body 的 font-family 保持一致
const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`

// 心情映射，与 Report.tsx 保持一致
const MOOD_EMOJI: Record<string, string> = { yum: "😋", ok: "😐", no: "😒" }
const MOOD_LABEL: Record<string, string> = { yum: "吃得美滋滋", ok: "还行", no: "不太满意" }

// 布局常量
const PAD = 48 // 页面左右留白
const CARD_X = PAD
const CARD_W = WIDTH - PAD * 2 // 卡片宽 654
const INSET = 28 // 卡片内边距
const IN_X = CARD_X + INSET
const IN_W = CARD_W - INSET * 2
const GAP = 20 // 卡片间距
const R = 24 // 卡片圆角

// 画笔函数：在 y 处绘制一个区块，返回新的 y 游标（两遍跑同一份函数，先量后画）
type Painter = (ctx: CanvasRenderingContext2D, y: number) => number

function font(weight: number, size: number): string {
  return `${weight} ${size}px ${FONT_STACK}`
}

// 数字兜底：后端字段可能为 null/NaN
function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

// "2026-10-26" -> "10.26"；格式异常时截掉年份前缀原样展示
function fmtShortDate(s: unknown): string {
  if (typeof s !== "string") return "--.--"
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim())
  if (!m) return s.slice(5) || "--.--"
  return `${m[2]}.${m[3]}`
}

// 生成日期取本地时区，避免 toISOString 的 UTC 偏移导致日期差一天
function todayLabel(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`
}

// 手写圆角矩形路径，兼容未实现 ctx.roundRect 的旧浏览器
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

// 超长文本截断加省略号（调用前需已设置好字体）
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!text) return ""
  if (ctx.measureText(text).width <= maxWidth) return text
  let out = text
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1)
  }
  return `${out}…`
}

// 白色圆角卡片，带与 app 一致的柔和投影
function drawCard(ctx: CanvasRenderingContext2D, top: number, h: number) {
  ctx.save()
  ctx.shadowColor = "rgba(26,26,46,.07)"
  ctx.shadowBlur = 18
  ctx.shadowOffsetY = 8
  roundRectPath(ctx, CARD_X, top, CARD_W, h, R)
  ctx.fillStyle = C.card
  ctx.fill()
  ctx.restore()
  roundRectPath(ctx, CARD_X, top, CARD_W, h, R)
  ctx.strokeStyle = C.border
  ctx.lineWidth = 1
  ctx.stroke()
}

// 卡片标题（含 emoji），文字中线在 cardTop + 50
function drawSectionTitle(ctx: CanvasRenderingContext2D, title: string, cardTop: number) {
  ctx.font = font(800, 28)
  ctx.fillStyle = C.text
  ctx.textAlign = "left"
  ctx.textBaseline = "middle"
  ctx.fillText(title, IN_X, cardTop + 50)
}

function drawDivider(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.save()
  ctx.strokeStyle = C.border
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.restore()
}

function drawLabel(ctx: CanvasRenderingContext2D, cx: number, cy: number, label: string) {
  ctx.font = font(500, 24)
  ctx.fillStyle = C.text2
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(label, cx, cy)
}

// 头部：应用名 + 周期（本周/本月 + 起止日期）+ 生成日期
function makeHeaderPainter(report: DietReport, appName: string): Painter {
  const name = appName || "NiniMenu"
  const label = report?.range === "month" ? "本月" : "本周"
  const dateText = `${fmtShortDate(report?.start_date)} - ${fmtShortDate(report?.end_date)}`
  return (ctx, y) => {
    // 头部柔和色块装饰
    ctx.save()
    ctx.fillStyle = "rgba(232,115,74,.10)"
    ctx.beginPath()
    ctx.arc(WIDTH - 48, y + 36, 92, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "rgba(110,198,184,.14)"
    ctx.beginPath()
    ctx.arc(56, y + 150, 64, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    ctx.textAlign = "center"
    ctx.textBaseline = "middle"

    // 应用名可能被用户改得很长，超宽时截断
    ctx.font = font(800, 24)
    ctx.fillStyle = C.primary
    ctx.fillText(ellipsize(ctx, name, WIDTH - PAD * 2), WIDTH / 2, y + 40)

    ctx.font = font(900, 46)
    ctx.fillStyle = C.text
    ctx.fillText(`${label}饮食报告`, WIDTH / 2, y + 96)

    ctx.font = font(600, 17)
    ctx.fillStyle = C.text2
    ctx.fillText(dateText, WIDTH / 2, y + 140)

    ctx.font = font(400, 13)
    ctx.fillStyle = C.text3
    ctx.fillText(`生成于 ${todayLabel()}`, WIDTH / 2, y + 172)
    return y + 204
  }
}

// 核心数字网格：下厨天数 / 总餐数（第一行），复做率 / 新菜率 / 平均评分（第二行）
function makeStatsPainter(cookDays: number, totalMeals: number, repeatRate: number, newDishRate: number, avgRating: number): Painter {
  return (ctx, y) => {
    const top = y + GAP
    const h = 278
    drawCard(ctx, top, h)

    // 第一行：两个大数字
    const row1Cy = top + 64
    drawValueWithUnit(ctx, CARD_X + CARD_W / 4, row1Cy, String(cookDays), "天")
    drawValueWithUnit(ctx, CARD_X + (CARD_W * 3) / 4, row1Cy, String(totalMeals), "顿")
    drawLabel(ctx, CARD_X + CARD_W / 4, top + 118, "下厨天数")
    drawLabel(ctx, CARD_X + (CARD_W * 3) / 4, top + 118, "总餐数")
    drawDivider(ctx, CARD_X + CARD_W / 2, top + 40, CARD_X + CARD_W / 2, top + 126)

    // 第二行：三个指标
    drawDivider(ctx, CARD_X + INSET, top + 152, CARD_X + CARD_W - INSET, top + 152)
    const row2Cy = top + 196
    drawMetric(ctx, CARD_X + CARD_W / 6, row2Cy, `${repeatRate}%`, "复做率", C.primary)
    drawMetric(ctx, CARD_X + CARD_W / 2, row2Cy, `${newDishRate}%`, "新菜率", C.mint)
    drawMetric(ctx, CARD_X + (CARD_W * 5) / 6, row2Cy, avgRating > 0 ? avgRating.toFixed(1) : "-", "平均评分", C.ratingGold)
    return top + h
  }
}

// 主数值 + 单位 组合居中绘制
function drawValueWithUnit(ctx: CanvasRenderingContext2D, cx: number, cy: number, value: string, unit: string) {
  ctx.textBaseline = "middle"
  ctx.font = font(800, 64)
  const vw = ctx.measureText(value).width
  ctx.font = font(600, 26)
  const uw = ctx.measureText(unit).width
  const startX = cx - (vw + 8 + uw) / 2

  ctx.font = font(800, 64)
  ctx.fillStyle = C.text
  ctx.textAlign = "left"
  ctx.fillText(value, startX, cy)
  ctx.font = font(600, 26)
  ctx.fillStyle = C.text2
  ctx.fillText(unit, startX + vw + 8, cy + 10)
}

function drawMetric(ctx: CanvasRenderingContext2D, cx: number, valueCy: number, value: string, label: string, color: string) {
  ctx.font = font(800, 36)
  ctx.fillStyle = color
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText(value, cx, valueCy)
  drawLabel(ctx, cx, valueCy + 44, label)
}

// 最常做的菜 Top5：名次圆点 + 菜名 + 次数
function makeTopDishesPainter(dishes: ReportTopDish[]): Painter {
  return (ctx, y) => {
    const top = y + GAP
    if (dishes.length === 0) {
      const h = 148
      drawCard(ctx, top, h)
      drawSectionTitle(ctx, "🏆 最常做的菜", top)
      ctx.font = font(400, 24)
      ctx.fillStyle = C.text3
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("这个周期还没有做饭记录", WIDTH / 2, top + 110)
      return top + h
    }
    const rowH = 64
    const h = 84 + rowH * dishes.length
    drawCard(ctx, top, h)
    drawSectionTitle(ctx, "🏆 最常做的菜", top)
    // 菜名可用宽度 = 卡片内容右缘 - 次数预留 110 - 名次圆点区 56
    const nameMaxW = CARD_X + CARD_W - INSET - 110 - (IN_X + 56)
    dishes.forEach((d, i) => {
      const cy = top + 84 + rowH * i + rowH / 2
      // 名次圆点：前三名主色，其余浅底
      ctx.beginPath()
      ctx.arc(IN_X + 20, cy, 20, 0, Math.PI * 2)
      ctx.fillStyle = i < 3 ? C.primary : C.bg
      ctx.fill()
      if (i >= 3) {
        ctx.strokeStyle = C.border
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      ctx.font = font(800, 20)
      ctx.fillStyle = i < 3 ? "#FFFFFF" : C.text3
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText(String(i + 1), IN_X + 20, cy + 1)

      ctx.font = font(500, 26)
      ctx.fillStyle = C.text
      ctx.textAlign = "left"
      ctx.fillText(ellipsize(ctx, d.dish_name || "未知菜品", nameMaxW), IN_X + 56, cy)

      ctx.font = font(700, 24)
      ctx.fillStyle = C.primary
      ctx.textAlign = "right"
      ctx.fillText(`${num(d.count)} 次`, CARD_X + CARD_W - INSET, cy)
    })
    return top + h
  }
}

// 口味偏好横条：按最大值归一
function makeTastePainter(shares: ReportShare[]): Painter {
  return (ctx, y) => {
    const top = y + GAP
    if (shares.length === 0) {
      const h = 148
      drawCard(ctx, top, h)
      drawSectionTitle(ctx, "👅 口味偏好", top)
      ctx.font = font(400, 24)
      ctx.fillStyle = C.text3
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("暂无数据", WIDTH / 2, top + 110)
      return top + h
    }
    const rowH = 56
    const h = 88 + rowH * shares.length
    drawCard(ctx, top, h)
    drawSectionTitle(ctx, "👅 口味偏好", top)
    const maxCount = Math.max(...shares.map((s) => num(s.count)), 1)
    const barX = IN_X + 164
    const barRight = CARD_X + CARD_W - INSET - 90
    const trackW = Math.max(0, barRight - barX)
    shares.forEach((s, i) => {
      const cy = top + 88 + rowH * i + rowH / 2

      ctx.font = font(500, 24)
      ctx.fillStyle = C.text2
      ctx.textAlign = "left"
      ctx.textBaseline = "middle"
      ctx.fillText(ellipsize(ctx, s.name || "未知", 150), IN_X, cy)

      // 轨道
      roundRectPath(ctx, barX, cy - 8, trackW, 16, 8)
      ctx.fillStyle = C.bg
      ctx.fill()
      // 填充条：宽度按最大值归一，至少留 16px 让小值可见
      const ratio = Math.max(0, Math.min(1, num(s.count) / maxCount))
      const fillW = ratio > 0 ? Math.min(trackW, Math.max(trackW * ratio, 16)) : 0
      if (fillW > 0) {
        roundRectPath(ctx, barX, cy - 8, fillW, 16, 8)
        ctx.fillStyle = C.primary
        ctx.fill()
      }

      ctx.font = font(700, 22)
      ctx.fillStyle = C.text3
      ctx.textAlign = "right"
      ctx.fillText(String(num(s.count)), CARD_X + CARD_W - INSET, cy)
    })
    return top + h
  }
}

// 吃饭心情 emoji 行
function makeMoodPainter(moods: ReportShare[]): Painter {
  return (ctx, y) => {
    const top = y + GAP
    const h = 216
    drawCard(ctx, top, h)
    drawSectionTitle(ctx, "💛 吃饭心情", top)
    ctx.textBaseline = "middle"
    if (moods.length === 0) {
      ctx.font = font(400, 24)
      ctx.fillStyle = C.text3
      ctx.textAlign = "center"
      ctx.fillText("暂无心情记录", WIDTH / 2, top + 110)
      return top + h
    }
    const chipTop = top + 88
    const chipH = 108
    const chipGap = 16
    const chipW = (IN_W - chipGap * (moods.length - 1)) / moods.length
    moods.forEach((m, i) => {
      const x = IN_X + i * (chipW + chipGap)
      const cx = x + chipW / 2
      const cy = chipTop + chipH / 2
      roundRectPath(ctx, x, chipTop, chipW, chipH, 18)
      ctx.fillStyle = C.bg
      ctx.fill()

      ctx.textAlign = "center"
      ctx.font = font(400, 40)
      ctx.fillStyle = C.text
      ctx.fillText(MOOD_EMOJI[m.name] || "🍽", cx, cy - 22)
      ctx.font = font(600, 22)
      ctx.fillStyle = C.text2
      // 未知的心情名可能是任意长文本，按芯片宽度截断
      ctx.fillText(ellipsize(ctx, MOOD_LABEL[m.name] || m.name, chipW - 20), cx, cy + 16)
      ctx.font = font(400, 20)
      ctx.fillStyle = C.text3
      ctx.fillText(`${num(m.count)} 天`, cx, cy + 42)
    })
    return top + h
  }
}

// 底部水印
const watermarkPainter: Painter = (ctx, y) => {
  ctx.font = font(500, 22)
  ctx.fillStyle = C.text3
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.fillText("NiniMenu · 今天也好好吃饭", WIDTH / 2, y + 40)
  return y + 64
}

function buildPainters(report: DietReport, appName: string): Painter[] {
  // 后端字段可能为 null：统一在这里兜底，painter 内只拿干净数据
  const r = report ?? ({} as DietReport)
  // 截断口径与后端一致（report_service.go countShares 上限：口味/菜系 6、心情 3、常做菜 5），
  // 保证分享长图与报告页展示相同条数
  const topDishes = (Array.isArray(r.top_dishes) ? r.top_dishes : []).slice(0, 5)
  const tastes = (Array.isArray(r.taste_shares) ? r.taste_shares : []).slice(0, 6)
  const moods = (Array.isArray(r.mood_shares) ? r.mood_shares : []).slice(0, 3)
  return [
    makeHeaderPainter(r, appName),
    makeStatsPainter(num(r.cook_days), num(r.total_meals), num(r.repeat_rate), num(r.new_dish_rate), num(r.avg_rating)),
    makeTopDishesPainter(topDishes),
    makeTastePainter(tastes),
    makeMoodPainter(moods),
    watermarkPainter,
  ]
}

// 绘制报告分享长图，返回离屏 canvas（位图宽 750*DPR，高按内容自适应）
export function renderReportImage(report: DietReport, appName: string): HTMLCanvasElement {
  const painters = buildPainters(report, appName)

  // 先量后画：第一遍在临时画布上空跑布局函数算出总高度
  const measureCtx = document.createElement("canvas").getContext("2d")
  let totalH = 0
  if (measureCtx) {
    for (const paint of painters) totalH = paint(measureCtx, totalH)
  }
  // 极端兜底：量不到高度时给一个不小于满数据布局（约 1614）的保守值，避免底部被裁
  if (!Number.isFinite(totalH) || totalH <= 0) totalH = 1800

  const canvas = document.createElement("canvas")
  canvas.width = WIDTH * DPR
  canvas.height = Math.ceil(totalH * DPR)

  const ctx = canvas.getContext("2d")
  if (!ctx) return canvas
  ctx.scale(DPR, DPR)
  let y = 0
  for (const paint of painters) y = paint(ctx, y)
  return canvas
}
