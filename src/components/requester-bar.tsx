import { useId, useState } from "react"
import { Globe, Smartphone } from "lucide-react"
import { hostParts } from "@/security/domain"
import { badgeExplainer, type Who } from "@/security/identity"

export interface RequesterView {
  readonly channel: "iframe" | "popup" | "redirect" | "webview" | "none"
  /** An origin (https://app.example), an app destination ("myapp://callback"), or null when unknown. */
  readonly label: string | null
  /** The registered app's name, when the requester is registered. */
  readonly appName?: string
  /** Further sites the request passed through (a nested frame). */
  readonly embeddedIn: readonly string[]
  /** The web page that sent the user here on the redirect channel. */
  readonly openedFrom: string | null
  /** What named the requester (ancestor-origins, message, referrer, none). */
  readonly evidence: string
}

/** The LazorKit mark: the first line of every portal screen. It names no domain (that is the passkey caption's job). */
export function TopBar() {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2" data-testid="top-bar">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="text-ink">
        <path d="M8 1 15 8 8 15 1 8Z" fill="currentColor" />
        <path d="M8 4.5 11.5 8 8 11.5 4.5 8Z" fill="var(--surface)" />
      </svg>
      <span className="text-[14px] leading-[20px] font-bold text-ink">LazorKit</span>
    </div>
  )
}

/** A host with its registered name set apart: www.<b>fernway</b>.example. Never cut short. */
export function Host({ host, insecure = false }: { host: string; insecure?: boolean }) {
  const parts = hostParts(host)
  return (
    <bdi dir="ltr" className="break-words">
      {insecure && <span>http://</span>}
      {parts.before}
      <strong className="font-bold text-ink">{parts.registrable}</strong>
      {parts.after}
    </bdi>
  )
}

/**
 * Who is asking, on every screen: the registered name with "Verified site",
 * or the host itself with "Not verified"; an app destination as "An app on
 * this phone". Tapping the badge says what it means, and what it doesn't.
 */
export function AppIdentity({ view, who, hidden = false }: { view: RequesterView; who: Who; hidden?: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const common = { "data-testid": "requester", "data-evidence": view.evidence, "data-channel": view.channel, "data-origin": who.origin ?? who.returnsTo ?? "" }
  if (hidden || who.kind === "unknown") return <div {...common} className="sr-only" />

  const letter = (who.kind === "site" ? (who.verified ? who.title : who.host ?? "?") : "a").replace(/^www\./, "").charAt(0).toUpperCase()
  const badge =
    who.kind === "site" ? (
      <button
        type="button"
        className="inline-flex min-h-11 shrink-0 items-center"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        data-testid="requester-badge"
        data-verified={who.verified ? "true" : "false"}
      >
        {who.verified ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[13px] leading-[18px] text-ink">
            <Globe className="h-3.5 w-3.5" aria-hidden="true" />
            Verified site
          </span>
        ) : (
          <span className="rounded-full bg-ground px-2 py-0.5 text-[13px] leading-[18px] text-ink-2">Not verified</span>
        )}
      </button>
    ) : null

  return (
    <div {...common} className="shrink-0 space-y-1 pb-1">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ground text-[15px] font-bold text-ink-2" aria-hidden="true">
          {who.kind === "app" ? <Smartphone className="h-4 w-4" /> : letter}
        </div>
        <div className="min-w-0 flex-1">
          {who.kind === "site" && who.verified && who.host ? (
            <>
              <p className="text-[17px] leading-[24px] font-bold text-ink" data-testid="requester-name">{who.title}</p>
              <p className="font-mono text-[13px] leading-[20px] text-ink-2" data-testid="requester-origin">
                <Host host={who.host} insecure={who.insecure} />
              </p>
            </>
          ) : who.kind === "site" && who.host ? (
            <p className="text-[17px] leading-[24px] font-normal text-ink-2" data-testid="requester-origin">
              <Host host={who.host} insecure={who.insecure} />
            </p>
          ) : (
            <>
              <p className="text-[17px] leading-[24px] font-bold text-ink" data-testid="requester-name">{who.title}</p>
              {who.returnsTo && (
                <p className="text-[13px] leading-[20px] text-ink-2">
                  Returns to{" "}
                  <bdi dir="ltr" className="break-all font-mono text-ink" data-testid="requester-origin">
                    {who.returnsTo}
                  </bdi>
                </p>
              )}
            </>
          )}
        </div>
        {badge}
      </div>
      {open && (
        <p id={id} className="text-[14px] leading-[20px] text-ink-2" data-testid="badge-explainer">
          {badgeExplainer(who)}
        </p>
      )}
    </div>
  )
}
