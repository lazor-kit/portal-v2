import type { ReactNode } from "react"
import { ChevronDown, Fingerprint, Info, OctagonAlert, Quote, TriangleAlert } from "lucide-react"
import { buttonClass } from "@/lib/ui"
import { portalHost } from "@/utils/portal"

/**
 * The parts every approval screen is built from, top to bottom: hero,
 * caution row, one sentence, up to two facts, Details, then the sticky
 * buttons with one caption line. Risk always carries an icon of its
 * own shape and words, never colour alone.
 */

export const HERO_ID = "lk-hero"

/** The main block: what is being asked, in seven words or fewer. `aria-labelledby` of the screen points here. */
export function Hero({ children, eyebrow, size = "action", testId }: { children: ReactNode; eyebrow?: ReactNode; size?: "action" | "amount"; testId?: string }) {
  return (
    <div className="space-y-1">
      {eyebrow}
      <h1
        id={HERO_ID}
        className={size === "amount" ? "text-[34px] leading-[40px] font-bold tracking-tight text-ink" : "text-[28px] leading-[34px] font-bold tracking-tight text-ink"}
        data-testid={testId ?? "hero"}
      >
        {children}
      </h1>
    </div>
  )
}

/** "❝ Fernway says": the hero's values are the app's claim, not something LazorKit compared. */
export function AppSays({ name, testId }: { name: string; testId?: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[15px] leading-[20px] text-ink-2" data-testid={testId}>
      <Quote className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{name} says</span>
    </p>
  )
}

export function Sentence({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="text-[16px] leading-[24px] text-ink" data-testid={testId}>
      {children}
    </p>
  )
}

export function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="text-[14px] leading-[20px] text-ink-2" data-testid={testId}>
      {children}
    </p>
  )
}

/** One caution: a triangle, and a reason in sixteen words or fewer. */
export function CautionRow({ children, testId = "caution" }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-caution-bg px-3 py-2.5 text-caution-ink" data-testid={testId}>
      <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <p className="text-[15px] leading-[22px]">
        <span className="sr-only">Caution: </span>
        {children}
      </p>
    </div>
  )
}

/** The danger block: replaces the hero when the risk is the request itself. */
export function DangerBlock({ title, children, testId = "danger" }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <div className="rounded-xl bg-danger-bg p-4 text-danger-ink" data-testid={testId}>
      <div className="flex items-start gap-2.5">
        <OctagonAlert className="mt-1 h-6 w-6 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <h1 id={HERO_ID} className="text-[24px] leading-[30px] font-bold">
            <span className="sr-only">Danger: </span>
            {title}
          </h1>
          <p className="text-[16px] leading-[24px]">{children}</p>
        </div>
      </div>
    </div>
  )
}

/** Information, not a risk. */
export function InfoRow({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl bg-info-bg px-3 py-2.5 text-info-ink" data-testid={testId}>
      <Info className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <p className="text-[15px] leading-[22px]">{children}</p>
    </div>
  )
}

export interface Row {
  readonly label: ReactNode
  readonly value: ReactNode
  readonly testId?: string
}

/** Up to two facts on the first view. A fact tied to a risk is shown as a caution instead. */
export function Facts({ rows }: { rows: readonly Row[] }) {
  if (!rows.length) return null
  return (
    <dl className="divide-y divide-line rounded-xl border border-line">
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2.5" data-testid={row.testId}>
          <dt className="text-[14px] leading-[20px] text-ink-2">{row.label}</dt>
          <dd className="text-[16px] leading-[24px] text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** One row of Details. */
function DetailRow({ row, mono = false }: { row: Row; mono?: boolean }) {
  return (
    <div className="space-y-0.5 py-2" data-testid={row.testId}>
      <dt className="text-[14px] leading-[20px] text-ink-2">{row.label}</dt>
      <dd className={mono ? "break-all font-mono text-[13px] leading-[20px] text-ink" : "text-[15px] leading-[22px] text-ink"}>{row.value}</dd>
    </div>
  )
}

/**
 * Details: closed until opened, in place; the buttons stay where they are.
 * `lead` is the first thing inside (the compare line, or the preview notice).
 */
export function Details({ lead, rows = [], experts = [], children }: { lead?: ReactNode; rows?: readonly Row[]; experts?: readonly Row[]; children?: ReactNode }) {
  return (
    <details className="lk-details rounded-xl border border-line" data-testid="details">
      <summary className="flex h-12 cursor-pointer items-center justify-between px-3 text-[16px] font-semibold text-ink" data-testid="details-toggle">
        Details
        <ChevronDown className="lk-chevron h-5 w-5 text-ink-2 transition-transform" aria-hidden="true" />
      </summary>
      <div className="space-y-1 border-t border-line px-3 pt-1 pb-3">
        {lead}
        {rows.length > 0 && (
          <dl className="divide-y divide-line">
            {rows.map((row, i) => (
              <DetailRow key={i} row={row} />
            ))}
          </dl>
        )}
        {children}
        {experts.length > 0 && (
          <div className="pt-2">
            <p className="text-[14px] leading-[20px] font-bold text-ink">For experts</p>
            <dl className="divide-y divide-line">
              {experts.map((row, i) => (
                <DetailRow key={i} row={row} mono />
              ))}
            </dl>
          </div>
        )}
      </div>
    </details>
  )
}

/** "= Matches what your passkey signs": the first line of Details, only when LazorKit compared the two. */
export function MatchLine() {
  return (
    <div className="flex items-start gap-2 py-2" data-testid="match-line">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-line text-[15px] leading-none font-bold text-ink-2" aria-hidden="true">
        =
      </span>
      <div>
        <p className="text-[15px] leading-[22px] font-semibold text-ink">Matches what your passkey signs</p>
        <p className="text-[14px] leading-[20px] text-ink-2">LazorKit compared these details with what will be signed. It doesn't judge whether this is a good idea.</p>
      </div>
    </div>
  )
}

/** The one caption line under the buttons: which passkey the device will ask for. */
export function Caption({ children, testId = "caption", passkey = true }: { children: ReactNode; testId?: string; passkey?: boolean }) {
  return (
    <p className="flex items-start justify-center gap-1.5 text-center text-[14px] leading-[20px] text-ink-2" data-testid={testId}>
      {passkey && <Fingerprint className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
      <span>{children}</span>
    </p>
  )
}

/**
 * The passkey caption: one short line by default; the longer explainer on
 * the first approval in this browser, and right after a passkey step that
 * didn't finish.
 */
export function PasskeyCaption({ explain = false }: { explain?: boolean }) {
  return explain ? (
    <Caption testId="caption-explainer">Your device may say “Sign in” for {portalHost()}. That's your approval.</Caption>
  ) : (
    <Caption>Passkey for {portalHost()}</Caption>
  )
}

/** A text button styled as a link, 44px tall. */
export function LinkButton({ children, onClick, testId, disabled }: { children: ReactNode; onClick: () => void; testId?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="mx-auto flex min-h-11 items-center px-2 text-[14px] leading-[20px] text-ink underline underline-offset-4 disabled:opacity-50"
      data-testid={testId}
    >
      {children}
    </button>
  )
}

/** A round status mark above a status screen's hero. */
export function StatusMark({ children }: { children: ReactNode }) {
  return <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ground text-ink-2">{children}</div>
}

/** The scrolling body of a screen; the sticky zone (buttons, caption) follows it. */
export function Body({ children, testId = "review-content" }: { children: ReactNode; testId?: string }) {
  return (
    <div className="min-h-[7.5rem] flex-1 space-y-3 overflow-y-auto pt-2 pb-3" data-testid={testId}>
      {children}
    </div>
  )
}

/** A button that is not an approval: Cancel, Back, Try again, Close. */
export function PlainButton({
  children,
  onClick,
  tone = "secondary",
  testId,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  tone?: "primary" | "secondary"
  testId?: string
  disabled?: boolean
}) {
  return (
    <button type="button" onClick={onClick} className={buttonClass(tone)} data-testid={testId} disabled={disabled}>
      {children}
    </button>
  )
}

/** The sticky zone: a row of buttons, then one caption line (and a link, if any). */
export function Actions({ children, caption, link, single = false }: { children?: ReactNode; caption?: ReactNode; link?: ReactNode; single?: boolean }) {
  return (
    <div className="shrink-0 space-y-2 border-t border-line pt-3" data-testid="actions">
      {children && <div className={single ? "grid grid-cols-1 gap-2" : "flex flex-col gap-2 min-[360px]:flex-row"}>{children}</div>}
      {caption}
      {link}
    </div>
  )
}
