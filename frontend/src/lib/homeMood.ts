export const homeMoodKeys = ["happy", "tired", "lazy", "spicy", "healthy"] as const
export type HomeMood = (typeof homeMoodKeys)[number]

export interface HomeMoodChoice {
  id: number
  date: string
  mood: HomeMood
}

export function savedHomeMood(value: unknown): HomeMood | null {
  return homeMoodKeys.includes(value as HomeMood) ? value as HomeMood : null
}

// A late initial read may update the server snapshot, but must not replace a pending choice.
export function selectedHomeMood(choice: HomeMoodChoice | null, date: string, saved: unknown): HomeMood | null {
  return choice?.date === date ? choice.mood : savedHomeMood(saved)
}

// Earlier saves may finish while a newer choice is queued; only the latest can settle the UI.
export function isCurrentMoodChoice(choice: HomeMoodChoice | null, request: HomeMoodChoice, date: string): boolean {
  return choice?.id === request.id && choice.date === request.date && request.date === date
}
