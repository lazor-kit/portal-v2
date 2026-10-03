import { useState } from "react"
import { AlertTriangle, KeyRound } from "lucide-react"
import { ApproveButtons } from "@/components/approve-buttons"
import { groupHex } from "@/security/display"

type ApprovalReviewProps = {
  requesterLabel: string
  framed: boolean
  busy: boolean
  error: string | null
  onApprove: () => void
  onCancel: () => void
} & ({ kind: "approval"; fingerprint: string } | { kind: "ownership" })

/**
 * A wallet change the app prepared (session, authority and similar), shown
 * by fingerprint with an explicit confirmation; or a proof that the user
 * holds this passkey, which approves nothing.
 */
export function ApprovalReview(props: ApprovalReviewProps) {
  const [confirmed, setConfirmed] = useState(false)

  return (
    <div className="space-y-3" data-testid="approval-review" data-kind={props.kind}>
      {props.kind === "ownership" ? (
        <>
          <h1 className="text-base font-bold text-foreground">Confirm it's you</h1>
          <div className="rounded-lg border border-border/60 bg-muted/40 p-3 flex items-start gap-2">
            <KeyRound className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {props.requesterLabel} asks you to confirm that you hold this passkey. Nothing is approved or paid.
            </p>
          </div>
        </>
      ) : (
        <>
          <h1 className="text-base font-bold text-foreground">Approve wallet change</h1>
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2.5 flex items-start gap-2" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-yellow-500 leading-tight">
              {props.requesterLabel} asks you to approve a wallet change it started. Details aren't shown for this kind of request.
              Approve only if you just asked this site to make a change.
            </p>
          </div>
          <div className="rounded-lg border border-border/60 bg-muted/40 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Fingerprint</p>
            <p className="text-xs font-mono break-all text-foreground" data-testid="fingerprint">{groupHex(props.fingerprint)}</p>
          </div>
          <label className="flex items-start gap-2 text-xs text-foreground">
            <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="confirm" />
            I started this change on {props.requesterLabel}.
          </label>
        </>
      )}

      {props.error && <p className="text-xs text-red-500" role="alert">{props.error}</p>}

      <ApproveButtons
        framed={props.framed}
        busy={props.busy}
        disabled={props.kind === "approval" && !confirmed}
        approveLabel={props.kind === "ownership" ? "Confirm" : "Approve"}
        onApprove={props.onApprove}
        onCancel={props.onCancel}
      />
    </div>
  )
}
