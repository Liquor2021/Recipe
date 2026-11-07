import type { Dish } from "../types/index.ts"

// 包含可编辑字段：即使旧数据没有更新时间，也能识别实际内容变化。
export function dishEditorRevision(dish?: Dish) {
  if (!dish) return "new"
  return JSON.stringify([
    dish.id, dish.updated_at, dish.name, dish.category, dish.meal_type, dish.difficulty,
    dish.taste, dish.cook_time, dish.ingredients, dish.seasonings, dish.steps, dish.remark,
    dish.image_url, dish.images, dish.video_url, dish.tags, dish.sort_order,
  ])
}

type UploadKind = "main" | "extra"
interface UploadTicket { kind: UploadKind; id: symbol }

// 每次挂载/重新载入都有独立会话；网络请求不能把旧图片写进另一份表单。
export function createDishEditorSession() {
  let active = true
  let saving = false
  let latestMain: symbol | null = null
  const uploads = new Set<UploadTicket>()
  const hasKind = (kind: UploadKind) => [...uploads].some((ticket) => ticket.kind === kind)
  return {
    activate() { active = true },
    dispose() { active = false; saving = false; latestMain = null; uploads.clear() },
    isActive: () => active,
    isBusy: () => saving || uploads.size > 0,
    beginSave() {
      if (!active || saving || uploads.size > 0) return false
      saving = true
      return true
    },
    finishSave() { saving = false },
    beginUpload(kind: UploadKind): UploadTicket | null {
      if (!active || saving || (kind === "extra" && hasKind("extra"))) return null
      const ticket = { kind, id: Symbol(kind) }
      if (kind === "main") latestMain = ticket.id
      uploads.add(ticket)
      return ticket
    },
    acceptsUpload(ticket: UploadTicket) {
      return active && uploads.has(ticket) && (ticket.kind === "extra" || ticket.id === latestMain)
    },
    finishUpload(ticket: UploadTicket) { uploads.delete(ticket) },
    uploadCounts() {
      return {
        main: [...uploads].filter((ticket) => ticket.kind === "main").length,
        extra: [...uploads].filter((ticket) => ticket.kind === "extra").length,
      }
    },
  }
}
