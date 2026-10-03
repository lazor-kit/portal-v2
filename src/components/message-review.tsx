import { useMemo, useState } from "react"
import { AlertTriangle } from "lucide-react"
import { ApproveButtons } from "@/components/approve-buttons"
import { groupHex, revealHidden } from "@/security/display"

type MessageReviewProps = {
  requesterLabel: string
  framed: boolean
  busy: boolean
  error: string | null
  onApprove: () => void
  onCancel: () => void
} & ({ kind: "message"; text: string } | { kind: "message-without-text"; fingerprint: string })

/** A message to sign: its exact text, or a fingerprint when it is not text at all. */
export function MessageReview(props: MessageReviewProps) {
  const [understood, setUnderstood] = useState(false)
  const shown = useMemo(() => (props.kind === "message" ? revealHidden(props.text) : null), [props])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="message-review" data-kind={props.kind}>
      <div className="min-h-[7.5rem] flex-1 space-y-3 overflow-y-auto" data-testid="review-content">
        <h1 className="text-base font-bold text-foreground">Sign message</h1>

        {props.kind === "message" && shown ? (
          <>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {props.requesterLabel} asks you to sign this message. Signing a message doesn't approve a transaction.
            </p>
            {shown.hidden > 0 && (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2.5 flex items-start gap-2" role="alert">
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-yellow-500 leading-tight">
                  This message contains {shown.hidden} invisible or direction-changing character{shown.hidden === 1 ? "" : "s"}, shown below as code points.
                </p>
              </div>
            )}
            <div
              className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/40 p-3 text-xs text-foreground whitespace-pre-wrap break-words font-mono"
              dir="ltr"
              data-testid="message-text"
            >
              {shown.segments.map((segment, i) =>
                segment.kind === "text" ? (
                  <bdi key={i}>{segment.text}</bdi>
                ) : (
                  <span key={i} className="mx-0.5 rounded bg-yellow-500/20 px-1 text-[10px] text-yellow-500">{segment.code}</span>
                ),
              )}
            </div>
          </>
        ) : props.kind === "message-without-text" ? (
          <>
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2.5 flex items-start gap-2" role="alert">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0 mt-0.5" />
              <p className="text-[11px] text-yellow-500 leading-tight">
                {props.requesterLabel} asks you to sign data that can't be shown as text. Sign only if you expected this.
              </p>
            </div>
            <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Fingerprint</p>
              <p className="text-xs font-mono break-all text-foreground" data-testid="fingerprint">{groupHex(props.fingerprint)}</p>
            </div>
            <label className="flex items-start gap-2 text-xs text-foreground">
              <input type="checkbox" className="mt-0.5" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} data-testid="confirm" />
              I expected to sign data from this site.
            </label>
          </>
        ) : null}

        {props.error && <p className="text-xs text-red-500" role="alert">{props.error}</p>}
      </div>

      <ApproveButtons
        framed={props.framed}
        busy={props.busy}
        disabled={props.kind === "message-without-text" && !understood}
        approveLabel="Sign"
        onApprove={props.onApprove}
        onCancel={props.onCancel}
      />
    </div>
  )
}
