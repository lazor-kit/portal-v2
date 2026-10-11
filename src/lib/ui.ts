/**
 * Button looks. `primary` is the recommended action: solid, on the right,
 * taking the room left over; on top when the buttons stack below 360px.
 * `secondary` and `danger-text` size to their label on the left; `link` is
 * underlined text, 44px tall.
 */
export type ButtonTone = "primary" | "secondary" | "danger-text" | "link"

const SIZE = "h-12 w-full rounded-xl px-4 text-[16px] leading-[20px] disabled:opacity-50"
const SIDE = "min-[360px]:w-auto min-[360px]:min-w-28 min-[360px]:shrink-0"

export function buttonClass(tone: ButtonTone): string {
  if (tone === "primary") return `${SIZE} bg-accent font-bold text-on-accent max-[359px]:order-first min-[360px]:w-auto min-[360px]:flex-1`
  if (tone === "danger-text") return `${SIZE} ${SIDE} font-bold text-danger-text underline underline-offset-4`
  if (tone === "link") return "min-h-11 rounded-lg px-2 text-[14px] leading-[20px] text-ink underline underline-offset-4 disabled:opacity-50"
  return `${SIZE} ${SIDE} border border-line bg-surface font-semibold text-ink`
}
