export function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

export function planDateShortcuts(now: Date) {
  const nextMonday = ((8 - now.getDay()) % 7) || 7
  return [["明天", 1], ["后天", 2], ["下周一", nextMonday]].map(([label, offset]) => {
    const date = new Date(now)
    date.setDate(date.getDate() + Number(offset))
    return { label: String(label), date: localDateKey(date) }
  })
}
