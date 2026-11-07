import { useState, useEffect, useRef } from "react"
import { useParams, useNavigate } from "react-router-dom"
import { useQuery, useMutation, useMutationState, useQueryClient } from "@tanstack/react-query"
import { dishesApi, uploadApi, settingsApi, getUploadErrorMessage } from "@/api"
import { asArray } from "@/lib/utils"
import { createDishEditorSession, dishEditorRevision } from "@/lib/dishEditorSession"
import type { Dish, DishInput } from "@/types"
import toast from "react-hot-toast"

const DEFAULT_CATEGORIES = ["家常菜", "川菜", "粤菜", "快手菜", "汤品", "主食", "小食"]
const DEFAULT_TASTES = ["酸", "甜", "辣", "鲜", "清淡", "咸鲜", "麻辣", "蒜香", "葱香", "酱香", "糖醋", "咖喱"]
const mealTypes = [
  { key: "lunch", label: "🍳 午餐" },
  { key: "dinner", label: "🍲 晚餐" },
  { key: "all", label: "通用" },
]
const difficulties = ["easy", "medium", "hard"]
const diffLabels = { easy: "简单", medium: "中等", hard: "困难" }

interface Ingredient { name: string; amount: string }
interface Step { text: string; time?: number }

function parseList(raw: unknown, fallback: string[]): string[] {
  const arr = asArray<string>(raw).filter((x) => typeof x === "string")
  return arr.length > 0 ? arr : fallback
}

// 把菜品的食材/步骤数组格式化成编辑框里的一行一项（兼容字符串与对象两种历史格式）
function fmtIngredient(item: unknown): string {
  if (typeof item === "string") return item
  if (typeof item === "object" && item !== null) {
    const o = item as Record<string, unknown>
    return `${o.name || ""} ${o.amount || ""}`.trim()
  }
  return String(item)
}

function fmtStep(item: unknown, i: number): string {
  if (typeof item === "string") return `${i + 1}. ${item}`
  if (typeof item === "object" && item !== null) {
    const o = item as Record<string, unknown>
    return `${i + 1}. ${o.text || ""}${o.time ? ` (${o.time}分钟)` : ""}`
  }
  return `${i + 1}. ${String(item)}`
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="text-xs font-bold text-primary uppercase tracking-wider mb-2.5">{title}</div>
      <div className="bg-card rounded-2xl p-4 shadow-sm border border-border space-y-4">
        {children}
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[13px] font-semibold mb-1.5 text-text2">{label}</label>
      {hint && <div className="text-[11px] text-text3 mb-1">{hint}</div>}
      {children}
    </div>
  )
}

const inputCls = "w-full py-2.5 px-3.5 rounded-[10px] border-[1.5px] border-border bg-bg text-sm outline-none transition-all focus:border-primary focus:shadow-[0_0_0_3px_rgba(232,115,74,.1)]"
const textareaCls = "w-full py-2.5 px-3.5 rounded-[10px] border-[1.5px] border-border bg-bg text-sm outline-none min-h-[80px] resize-y leading-relaxed transition-all focus:border-primary"

export default function AdminDishEdit() {
  const { id } = useParams()
  const isNew = !id || id === "new"
  return <DishEditorLoader key={isNew ? "new" : id} dishId={isNew ? 0 : Number(id)} isNew={isNew} />
}

function DishEditorLoader({ dishId, isNew }: { dishId: number; isNew: boolean }) {
  const navigate = useNavigate()
  const validId = Number.isSafeInteger(dishId) && dishId > 0
  const query = useQuery({
    queryKey: ["dish", dishId, "admin"],
    queryFn: () => dishesApi.getFresh(dishId),
    enabled: !isNew && validId,
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  })
  const [selected, setSelected] = useState<{ dish: Dish; generation: number } | null>(null)
  // 只有这次进入编辑页后的读取成功，才创建草稿；缓存不能替代首次校验。
  if (!isNew && !selected && query.isFetchedAfterMount && query.isSuccess && query.data?.id === dishId) {
    setSelected({ dish: query.data, generation: 0 })
  }
  if (!isNew && !selected) {
    const failed = !validId || query.isError || (query.isFetchedAfterMount && query.data?.id !== dishId)
    return (
      <div className="px-5 py-8 max-w-[640px] mx-auto">
        <div className="text-lg font-bold mb-4">编辑菜品</div>
        <div role={failed ? "alert" : "status"} className="rounded-2xl border border-border bg-card p-6 text-center">
          <div className="text-sm font-semibold">{failed ? "菜谱暂时无法读取" : "正在读取菜谱…"}</div>
          {failed && <>
            <p className="mt-2 text-xs text-text2">读取成功后才能编辑，已有菜谱不会被空表单覆盖。</p>
            <div className="flex justify-center gap-3 mt-4">
              <button onClick={() => navigate(-1)} className="px-4 py-2 rounded-full border border-border text-sm">返回</button>
              {validId && <button disabled={query.isFetching} onClick={() => { void query.refetch() }} className="px-4 py-2 rounded-full bg-primary text-white text-sm disabled:opacity-50">{query.isFetching ? "读取中…" : "重新读取"}</button>}
            </div>
          </>}
        </div>
      </div>
    )
  }
  return <DishEditorForm
    key={selected?.generation ?? 0}
    initialDish={selected?.dish}
    latestDish={query.data}
    readFailed={!isNew && query.isError}
    reading={!isNew && query.isFetching}
    onRetry={() => { void query.refetch() }}
    onReload={(dish) => setSelected((previous) => ({ dish, generation: (previous?.generation ?? 0) + 1 }))}
  />
}

function DishEditorForm({ initialDish, latestDish, readFailed, reading, onRetry, onReload }: {
  initialDish?: Dish
  latestDish?: Dish
  readFailed: boolean
  reading: boolean
  onRetry: () => void
  onReload: (dish: Dish) => void
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const isNew = !initialDish
  const dishId = initialDish?.id || 0
  const [session] = useState(createDishEditorSession)
  useEffect(() => {
    session.activate()
    return () => session.dispose()
  }, [session])
  const [knownRevision, setKnownRevision] = useState(() => dishEditorRevision(initialDish))
  const serverChanged = !isNew && !!latestDish && dishEditorRevision(latestDish) !== knownRevision
  const [uploads, setUploads] = useState({ main: 0, extra: 0 })
  const uploading = uploads.main + uploads.extra > 0
  const [uploadMessage, setUploadMessage] = useState("")
  const settingsQuery = useQuery({
    queryKey: ["settings", "admin"],
    queryFn: () => settingsApi.getFresh(),
    refetchOnMount: "always",
    retry: false,
  })
  const settings = settingsQuery.data
  const settingsReady = settingsQuery.isFetchedAfterMount && settingsQuery.isSuccess && !settingsQuery.isFetching
  const settingsSaving = useRef(false)
  const settingsBusy = useMutationState({ filters: { mutationKey: ["settings-edit"], status: "pending" } }).length > 0
  const categories = parseList(settings?.categories, DEFAULT_CATEGORIES)
  const tastes = parseList(settings?.tastes, DEFAULT_TASTES)

  const [name, setName] = useState(initialDish?.name || "")
  const [category, setCategory] = useState(initialDish?.category || "家常菜")
  const [mealType, setMealType] = useState(initialDish?.meal_type || "all")
  const [difficulty, setDifficulty] = useState(initialDish?.difficulty || "easy")
  const [tasteList, setTasteList] = useState(() => (initialDish?.taste || "").split(",").map((t) => t.trim()).filter(Boolean))
  const [cookTime, setCookTime] = useState(initialDish?.cook_time || 15)
  const [ingredientsText, setIngredientsText] = useState(() => asArray(initialDish?.ingredients).map(fmtIngredient).join("\n"))
  const [seasoningsText, setSeasoningsText] = useState(() => asArray(initialDish?.seasonings).map(fmtIngredient).join("\n"))
  const [stepsText, setStepsText] = useState(() => asArray(initialDish?.steps).map(fmtStep).join("\n"))
  const [remark, setRemark] = useState(initialDish?.remark || "")
  const [imageUrl, setImageUrl] = useState(initialDish?.image_url || "")
  const [images, setImages] = useState(() => asArray<string>(initialDish?.images).filter((x) => typeof x === "string"))
  const [videoUrl, setVideoUrl] = useState(initialDish?.video_url || "")
  const [tags, setTags] = useState(() => asArray<string>(initialDish?.tags).filter((x) => typeof x === "string"))
  const [tagInput, setTagInput] = useState("")
  const [sortOrder, setSortOrder] = useState(initialDish?.sort_order || 0)
  const [addingCategory, setAddingCategory] = useState(false)
  const [addingTaste, setAddingTaste] = useState(false)
  const [newCategory, setNewCategory] = useState("")
  const [newTaste, setNewTaste] = useState("")
  const [manageCategory, setManageCategory] = useState(false)
  const [manageTaste, setManageTaste] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{ type: "category" | "taste"; value: string } | null>(null)

  const currentDraft = JSON.stringify([name, category, mealType, difficulty, tasteList, cookTime,
    ingredientsText, seasoningsText, stepsText, remark, imageUrl, images, videoUrl, tags, sortOrder])
  const [originalDraft] = useState(currentDraft)
  const dirty = currentDraft !== originalDraft || tagInput.trim() !== ""

  function reloadServerDraft() {
    if (!latestDish || readFailed || reading || session.isBusy()) return
    if (dirty && !window.confirm("重新载入会放弃当前未保存的编辑，确认载入最新菜谱吗？")) return
    onReload(latestDish)
  }

  function keepCurrentDraft() {
    if (!latestDish || readFailed || reading || session.isBusy()) return
    if (!window.confirm("保留当前编辑后，下次保存会覆盖服务器上的新版菜谱。确认继续吗？")) return
    setKnownRevision(dishEditorRevision(latestDish))
  }

  function parseIngredients(text: string): Ingredient[] {
    return text.split("\n").filter((l) => l.trim()).map((l) => {
      const parts = l.trim().split(/\s+/)
      if (parts.length === 1) return { name: parts[0], amount: "" }
      return { name: parts.slice(0, -1).join(" "), amount: parts[parts.length - 1] }
    })
  }

  function parseSteps(text: string): Step[] {
    return text.split("\n").filter((l) => l.trim()).map((l) => {
      const cleaned = l.replace(/^\d+\.\s*/, "")
      const timeMatch = cleaned.match(/\((\d+)分钟\)/)
      return { text: cleaned.replace(/\(\d+分钟\)/, "").trim(), time: timeMatch ? Number(timeMatch[1]) : undefined }
    })
  }

  const saveMut = useMutation({
    mutationFn: (data: DishInput) => isNew ? dishesApi.create(data) : dishesApi.update(dishId, data),
    onSuccess: async (saved) => {
      // 先取消旧读取，再写入真实保存结果，返回详情页时不再短暂显示旧菜谱。
      await qc.cancelQueries({ queryKey: ["dish", saved.id] })
      qc.setQueryData(["dish", saved.id], saved)
      qc.setQueryData(["dish", saved.id, "admin"], saved)
      for (const key of [["admin", "dishes"], ["dishes"], ["favorites"], ["fridge-recipes"]]) {
        void qc.invalidateQueries({ queryKey: key })
      }
      if (session.isActive()) {
        toast.success("已保存")
        navigate(-1)
      }
    },
    onError: (err: unknown) => { if (session.isActive()) toast.error(getUploadErrorMessage(err, "保存失败")) },
    onSettled: () => session.finishSave(),
  })

  function saveDish() {
    if (!name.trim() || serverChanged || readFailed || reading || !session.beginSave()) return
    saveMut.mutate({
      name: name.trim(), category, meal_type: mealType, difficulty, taste: tasteList.join(","),
      cook_time: cookTime, ingredients: JSON.stringify(parseIngredients(ingredientsText)),
      seasonings: JSON.stringify(parseIngredients(seasoningsText)), steps: JSON.stringify(parseSteps(stepsText)),
      remark, image_url: imageUrl, images: JSON.stringify(images), video_url: videoUrl,
      tags: JSON.stringify(tags), sort_order: sortOrder,
    })
  }

  type SettingChange = { type: "category" | "taste"; action: "add" | "delete"; value: string }
  const settingMut = useMutation({
    mutationKey: ["settings-edit", "classification"],
    mutationFn: ({ type, action, value }: SettingChange) => {
      const values = type === "category" ? categories : tastes
      const next = action === "add" ? [...new Set([...values, value])] : values.filter((item) => item !== value)
      return settingsApi.update({ [type === "category" ? "categories" : "tastes"]: JSON.stringify(next) })
    },
    onSuccess: async (_data, { type, action, value }) => {
      await qc.invalidateQueries({ queryKey: ["settings"] })
      if (!session.isActive()) return
      if (type === "category") {
        if (action === "add") { setCategory(value); setNewCategory(""); setAddingCategory(false) }
        else if (category === value) setCategory("")
      } else {
        setTasteList((prev) => action === "add" ? [...new Set([...prev, value])] : prev.filter((item) => item !== value))
        if (action === "add") { setNewTaste(""); setAddingTaste(false) }
      }
      setPendingDelete(null)
      toast.success(`已${action === "add" ? "添加" : "删除"}${type === "category" ? "分类" : "口味"}`)
    },
    onError: (err: unknown) => { if (session.isActive()) toast.error(getUploadErrorMessage(err, "修改失败，请重试")) },
    onSettled: () => { settingsSaving.current = false },
  })
  const settingsLocked = !settingsReady || settingsBusy

  function changeSetting(type: SettingChange["type"], action: SettingChange["action"], value: string) {
    if (settingsLocked || settingsSaving.current || qc.isMutating({ mutationKey: ["settings-edit"] }) > 0 || !value.trim()) return
    settingsSaving.current = true
    settingMut.mutate({ type, action, value: value.trim() })
  }

  function confirmDelete() {
    if (!pendingDelete) return
    changeSetting(pendingDelete.type, "delete", pendingDelete.value)
  }

  function toggleTaste(t: string) {
    setTasteList((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0]
    e.currentTarget.value = ""
    if (!file) return
    const ticket = session.beginUpload("main")
    if (!ticket) return
    setUploads(session.uploadCounts())
    setUploadMessage("")
    try {
      const res = await uploadApi.image(file)
      if (!session.acceptsUpload(ticket)) return
      setImageUrl(res.data.data.url)
      setUploadMessage("主图已上传，保存菜品后生效")
      toast.success("主图已上传")
    } catch (err) {
      if (session.acceptsUpload(ticket)) {
        setUploadMessage("主图上传失败，可重新选择图片")
        toast.error(getUploadErrorMessage(err))
      }
    } finally {
      session.finishUpload(ticket)
      if (session.isActive()) setUploads(session.uploadCounts())
    }
  }

  async function handleExtraImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.currentTarget.files || [])
    e.currentTarget.value = ""
    if (files.length === 0) return
    const ticket = session.beginUpload("extra")
    if (!ticket) return
    setUploads(session.uploadCounts())
    setUploadMessage("")
    let succeeded = 0
    let failed = 0
    try {
      for (const file of files) {
        if (!session.acceptsUpload(ticket)) return
        try {
          const res = await uploadApi.image(file)
          if (!session.acceptsUpload(ticket)) return
          setImages((previous) => [...previous, res.data.data.url])
          succeeded++
        } catch {
          if (!session.acceptsUpload(ticket)) return
          failed++
        }
      }
      const message = failed > 0 ? `已上传 ${succeeded} 张，${failed} 张失败，请重新选择失败的图片` : `已上传 ${succeeded} 张图片，保存菜品后生效`
      setUploadMessage(message)
      if (failed > 0) toast.error(message)
      else toast.success(`已上传 ${succeeded} 张图片`)
    } finally {
      session.finishUpload(ticket)
      if (session.isActive()) setUploads(session.uploadCounts())
    }
  }

  function addTag() {
    const t = tagInput.trim()
    if (t && !tags.includes(t)) {
      setTags([...tags, t])
    }
    setTagInput("")
  }

  const pillClass = (active: boolean) =>
    `inline-flex items-center rounded-full text-xs border-[1.5px] transition-all ${active ? "bg-primary text-white border-primary" : "border-border text-text2"}`

  return (
    <div className="px-5 py-4 max-w-[640px] mx-auto pb-20">
      <div className="flex items-center justify-between mb-4">
        <div className="text-lg font-bold">{isNew ? "添加菜品" : "编辑菜品"}</div>
        <button onClick={saveDish} disabled={!name.trim() || saveMut.isPending || uploading || serverChanged || readFailed || reading} className="py-1.5 px-5 rounded-full text-xs font-semibold bg-primary text-white transition-all active:scale-96 disabled:opacity-50">
          {saveMut.isPending ? "保存中..." : uploading ? "图片上传中…" : "保存菜品"}
        </button>
      </div>

      {readFailed && <div role="alert" className="mb-4 rounded-2xl border border-border bg-card p-4 text-sm">
        <p className="font-semibold">最新菜谱读取失败，当前编辑已保留</p>
        <p className="mt-1 text-xs text-text2">重新读取成功后才能保存。</p>
        <button disabled={reading || uploading || saveMut.isPending} onClick={onRetry} className="mt-2 min-h-10 font-semibold text-primary disabled:opacity-50">{reading ? "读取中…" : "重新读取最新菜谱"}</button>
      </div>}
      {serverChanged && <div role="alert" className="mb-4 rounded-2xl border border-border bg-primary-light p-4 text-sm">
        <p className="font-semibold">菜谱已有更新，当前编辑已保留</p>
        <p className="mt-1 text-xs text-text2">选择载入最新内容，或确认保留当前编辑后再保存。</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button disabled={uploading || saveMut.isPending || readFailed || reading} onClick={reloadServerDraft} className="min-h-10 rounded-full bg-primary px-4 text-xs font-bold text-white disabled:opacity-50">载入最新内容</button>
          <button disabled={uploading || saveMut.isPending || readFailed || reading} onClick={keepCurrentDraft} className="min-h-10 rounded-full border border-border bg-card px-4 text-xs font-bold disabled:opacity-50">保留当前编辑</button>
        </div>
      </div>}
      {uploading && <div role="status" className="mb-4 rounded-xl border border-border bg-card px-4 py-3 text-sm text-text2">图片正在上传，请完成后再保存。{uploads.main > 0 ? "主图可重新选择，以最后一次选择为准。" : ""}</div>}

      {settingsQuery.isError && <div role="alert" className="mb-4 rounded-2xl border border-border bg-card p-4 text-sm">
        <p className="font-semibold">分类和口味暂时无法读取</p>
        <p className="mt-1 text-xs text-text2">菜品草稿已保留，重新读取成功后才能增删分类和口味。</p>
        <button disabled={settingsQuery.isFetching || settingMut.isPending} onClick={() => { void settingsQuery.refetch() }} className="mt-2 min-h-10 font-semibold text-primary disabled:opacity-50">{settingsQuery.isFetching ? "读取中…" : "重新读取分类和口味"}</button>
      </div>}

      <fieldset disabled={saveMut.isPending} className="min-w-0">
      <Section title="基本信息">
        <Field label="菜品名称 *" hint="必填">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：番茄炒蛋" className={inputCls} />
        </Field>

        <Field label="分类">
          <div className="flex items-center justify-between mb-1.5">
            <span />
            <button disabled={settingsLocked} onClick={() => setManageCategory((v) => !v)} className={`text-[12px] px-2 py-0.5 rounded-full transition-all ${manageCategory ? "bg-primary text-white" : "text-text3 hover:text-primary"}`}>{manageCategory ? "完成" : "管理"}</button>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {categories.map((c) => (
              <span key={c} className={pillClass(category === c && !manageCategory)}>
                <button onClick={() => !manageCategory && setCategory(c)} className="pl-3.5 pr-2 py-1.5 active:scale-95">{c}</button>
                {manageCategory && (
                  <button disabled={settingsLocked} onClick={() => setPendingDelete({ type: "category", value: c })} className="pr-2.5 pl-0.5 py-1.5 text-text3 hover:text-red-500">✕</button>
                )}
              </span>
            ))}
            {addingCategory ? (
              <div className="flex items-center gap-1">
                <input autoFocus disabled={settingMut.isPending} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && newCategory.trim()) changeSetting("category", "add", newCategory); if (e.key === "Escape") setAddingCategory(false) }}
                  placeholder="新分类" className="w-24 px-2.5 py-1.5 rounded-full text-xs border-[1.5px] border-primary bg-bg outline-none" />
                <button disabled={settingsLocked} onClick={() => newCategory.trim() && changeSetting("category", "add", newCategory)} className="px-2.5 py-1.5 rounded-full text-xs bg-primary text-white">✓</button>
                <button onClick={() => { setAddingCategory(false); setNewCategory("") }} className="px-2.5 py-1.5 rounded-full text-xs border border-border text-text2">✕</button>
              </div>
            ) : (
              <button disabled={settingsLocked} onClick={() => setAddingCategory(true)} className="px-3.5 py-1.5 rounded-full text-xs border-[1.5px] border-dashed border-border2 text-text2">+ 自定义</button>
            )}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="适合餐次">
            <div className="flex flex-wrap gap-2">
              {mealTypes.map((m) => (
                <button key={m.key} onClick={() => setMealType(m.key)} className={`px-3.5 py-1.5 rounded-full text-xs border-[1.5px] transition-all active:scale-95 ${mealType === m.key ? "bg-primary text-white border-primary" : "border-border text-text2"}`}>{m.label}</button>
              ))}
            </div>
          </Field>
          <Field label="难度">
            <div className="flex flex-wrap gap-2">
              {difficulties.map((d) => (
                <button key={d} onClick={() => setDifficulty(d)} className={`px-3.5 py-1.5 rounded-full text-xs border-[1.5px] transition-all active:scale-95 ${difficulty === d ? "bg-primary text-white border-primary" : "border-border text-text2"}`}>{diffLabels[d as keyof typeof diffLabels]}</button>
              ))}
            </div>
          </Field>
        </div>

        <Field label="口味（可多选）">
          <div className="flex items-center justify-between mb-1.5">
            <span />
            <button disabled={settingsLocked} onClick={() => setManageTaste((v) => !v)} className={`text-[12px] px-2 py-0.5 rounded-full transition-all ${manageTaste ? "bg-primary text-white" : "text-text3 hover:text-primary"}`}>{manageTaste ? "完成" : "管理"}</button>
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {tastes.map((t) => (
              <span key={t} className={pillClass(tasteList.includes(t) && !manageTaste)}>
                <button onClick={() => !manageTaste && toggleTaste(t)} className="pl-3.5 pr-2 py-1.5 active:scale-95">{t}</button>
                {manageTaste && (
                  <button disabled={settingsLocked} onClick={() => setPendingDelete({ type: "taste", value: t })} className="pr-2.5 pl-0.5 py-1.5 text-text3 hover:text-red-500">✕</button>
                )}
              </span>
            ))}
            {addingTaste ? (
              <div className="flex items-center gap-1">
                <input autoFocus disabled={settingMut.isPending} value={newTaste} onChange={(e) => setNewTaste(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && newTaste.trim()) changeSetting("taste", "add", newTaste); if (e.key === "Escape") setAddingTaste(false) }}
                  placeholder="新口味" className="w-24 px-2.5 py-1.5 rounded-full text-xs border-[1.5px] border-primary bg-bg outline-none" />
                <button disabled={settingsLocked} onClick={() => newTaste.trim() && changeSetting("taste", "add", newTaste)} className="px-2.5 py-1.5 rounded-full text-xs bg-primary text-white">✓</button>
                <button onClick={() => { setAddingTaste(false); setNewTaste("") }} className="px-2.5 py-1.5 rounded-full text-xs border border-border text-text2">✕</button>
              </div>
            ) : (
              <button disabled={settingsLocked} onClick={() => setAddingTaste(true)} className="px-3.5 py-1.5 rounded-full text-xs border-[1.5px] border-dashed border-border2 text-text2">+ 自定义</button>
            )}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="烹饪时间（分钟）">
            <input type="number" value={cookTime} onChange={(e) => setCookTime(Number(e.target.value))} min={1} className={inputCls} />
          </Field>
          <Field label="排序权重" hint="数值越大越靠前">
            <input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} className={inputCls} />
          </Field>
        </div>
      </Section>

      <Section title="图片与视频">
        <Field label="主图" hint="点击上传或替换菜品主图（支持 jpg/png/webp，最大5MB）">
          <label className="block border-2 border-dashed border-border2 rounded-2xl overflow-hidden text-center cursor-pointer transition-all hover:border-primary hover:bg-primary-light">
            <input type="file" accept="image/*" aria-label="上传菜品主图" onChange={handleImageUpload} className="hidden" />
            {imageUrl ? (
              <img src={imageUrl} alt="预览" className="w-full h-48 object-cover" />
            ) : (
              <div className="p-6">
                <span className="text-[32px] block mb-2">📷</span>
                <div className="text-[13px] text-text2">点击上传主图</div>
              </div>
            )}
          </label>
        </Field>

        <Field label="额外图片" hint="可上传多张菜品图片">
          <label className="block border-2 border-dashed border-border2 rounded-xl overflow-hidden text-center cursor-pointer py-3 px-4 transition-all hover:border-primary hover:bg-primary-light">
            <input type="file" accept="image/*" multiple aria-label="上传额外图片" disabled={uploads.extra > 0} onChange={handleExtraImageUpload} className="hidden" />
            <span className="text-xs text-text2">{uploads.extra > 0 ? "额外图片上传中…" : "+ 点击上传更多图片（可多选）"}</span>
          </label>
          {images.length > 0 && (
            <div className="flex gap-2 mt-3 overflow-x-auto scrollbar-hide">
              {images.map((img, i) => (
                <div key={i} className="relative flex-shrink-0 w-20 h-20 rounded-xl overflow-hidden group">
                  <img src={img} alt="" className="w-full h-full object-cover" />
                  <button
                    disabled={uploading}
                    aria-label={`删除额外图片 ${i + 1}`}
                    onClick={() => setImages(images.filter((_, j) => j !== i))}
                    className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </Field>

        {uploadMessage && <p role="status" className="text-xs text-text2">{uploadMessage}</p>}
        <Field label="教程视频链接" hint="B站/抖音/YouTube 视频链接，点击可跳转">
          <input type="text" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} placeholder="粘贴视频链接" className={inputCls} />
        </Field>
      </Section>

      <Section title="食材与步骤">
        <Field label="配料清单" hint="每行：名称 数量，最后一段为数量">
          <textarea value={ingredientsText} onChange={(e) => setIngredientsText(e.target.value)} rows={4} placeholder={"番茄 2个\n鸡蛋 3个"} className={textareaCls} />
        </Field>

        <Field label="调料清单" hint="每行：名称 数量">
          <textarea value={seasoningsText} onChange={(e) => setSeasoningsText(e.target.value)} rows={2} placeholder={"盐 1茶匙\n白糖 1茶匙"} className={textareaCls} />
        </Field>

        <Field label="制作步骤" hint="每行一步，可选(分钟数)标注时间">
          <textarea value={stepsText} onChange={(e) => setStepsText(e.target.value)} rows={4} placeholder={"1. 番茄洗净切块 (3分钟)\n2. 倒入蛋液翻炒"} className={textareaCls} />
        </Field>
      </Section>

      <Section title="标签与备注">
        <Field label="标签" hint="添加自定义标签方便筛选">
          <div className="flex flex-wrap gap-2 mb-2">
            {tags.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs bg-primary-light text-primary font-semibold">
                {t}
                <button onClick={() => setTags(tags.filter((x) => x !== t))} className="hover:text-red-500">✕</button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text" value={tagInput} onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag() } }}
              placeholder="输入标签后回车添加" className={`flex-1 ${inputCls}`}
            />
            <button onClick={addTag} className="px-4 rounded-full text-xs font-semibold bg-primary text-white">添加</button>
          </div>
        </Field>

        <Field label="备注" hint="烹饪小贴士、注意事项等">
          <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} placeholder="一些小贴士..." className={`${textareaCls} min-h-[60px]`} />
        </Field>
      </Section>

      <div className="flex gap-2.5 mt-2">
        <button onClick={() => navigate(-1)} className="flex-1 py-2.5 px-5 rounded-full text-sm font-semibold border-[1.5px] border-border2 transition-all">取消</button>
        <button onClick={saveDish} disabled={!name.trim() || saveMut.isPending || uploading || serverChanged || readFailed || reading} className="flex-1 py-2.5 px-5 rounded-full text-sm font-semibold bg-primary text-white transition-all active:scale-96 disabled:opacity-50">
          {saveMut.isPending ? "保存中..." : uploading ? "图片上传中…" : "保存菜品"}
        </button>
      </div>

      </fieldset>

      {pendingDelete && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm" onClick={() => setPendingDelete(null)}>
          <div className="bg-card rounded-2xl p-5 w-full max-w-[320px] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-base font-bold mb-1.5">删除{pendingDelete.type === "category" ? "分类" : "口味"}</div>
            <div className="text-sm text-text2 mb-5">确定删除「{pendingDelete.value}」吗？此操作不可撤销。</div>
            <div className="flex gap-2.5">
              <button disabled={settingsLocked} onClick={() => setPendingDelete(null)} className="flex-1 py-2.5 px-5 rounded-full text-sm font-semibold border-[1.5px] border-border2">取消</button>
              <button onClick={confirmDelete} disabled={settingsLocked} className="flex-1 py-2.5 px-5 rounded-full text-sm font-semibold bg-red-500 text-white disabled:opacity-50">删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
