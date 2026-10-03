import { Globe, Smartphone } from "lucide-react"

export interface RequesterView {
  readonly channel: "iframe" | "popup" | "redirect" | "webview" | "none"
  /** An origin (https://app.example), "scheme://" for an app, or null when unknown. */
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

/** Who is asking, on every screen: the browser-reported origin, or where the result returns. */
export function RequesterBar({ view }: { view: RequesterView }) {
  const redirect = view.channel === "redirect"
  const Icon = redirect && view.label && !view.label.startsWith("http") ? Smartphone : Globe
  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 px-3 py-2 space-y-1" data-testid="requester" data-evidence={view.evidence} data-channel={view.channel}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{redirect ? "Returns to" : "Request from"}</span>
        </div>
        {view.label && (
          view.appName ? (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-green-500/30 bg-green-500/10 text-green-500 shrink-0" data-testid="requester-badge">
              Registered: {view.appName}
            </span>
          ) : (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-yellow-500/30 bg-yellow-500/10 text-yellow-500 shrink-0" data-testid="requester-badge">
              Not registered
            </span>
          )
        )}
      </div>
      {/* Never truncated: the end of a host name is the part that tells look-alikes apart. */}
      <p className="text-xs font-mono font-medium text-foreground break-all leading-snug" data-testid="requester-origin">
        {view.label ?? "Unknown site"}
      </p>
      {view.embeddedIn.length > 0 && (
        <p className="text-[10px] text-yellow-500 leading-tight">Inside {view.embeddedIn.join(" › ")}</p>
      )}
      {redirect && view.openedFrom && (
        <p className="text-[10px] text-muted-foreground leading-tight">Opened from {view.openedFrom}</p>
      )}
    </div>
  )
}
