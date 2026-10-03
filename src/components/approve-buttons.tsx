import { Loader2 } from "lucide-react"
import type { MouseEvent } from "react"
import { Button } from "@/components/ui/button"
import { isTrustedActivation, useActivationGuard } from "@/security/gesture"

interface ApproveButtonsProps {
  onApprove: () => void
  onCancel: () => void
  framed: boolean
  busy?: boolean
  /** Further reason to keep Approve off (an unticked confirmation, say). */
  disabled?: boolean
  approveLabel?: string
  /** Approve as the secondary button, Cancel as the primary (a failed simulation). */
  discourage?: boolean
}

/** Cancel and Approve; Approve acts only on a real, visible click (see security/gesture). */
export function ApproveButtons({ onApprove, onCancel, framed, busy = false, disabled = false, approveLabel = "Approve", discourage = false }: ApproveButtonsProps) {
  const guard = useActivationGuard(framed, !busy)
  const ready = guard.state === "ready"

  const approve = (event: MouseEvent<HTMLButtonElement>) => {
    if (!ready || disabled || busy || !isTrustedActivation(event.nativeEvent)) return
    onApprove()
  }

  const secondary = "w-full bg-muted/50 hover:bg-muted text-foreground font-semibold py-2 rounded-lg h-10 text-sm border-border/50"
  const primary = "w-full font-semibold py-2 rounded-lg h-10 text-sm"

  return (
    <div className="space-y-1.5 pt-1">
      {/* Observed as a whole: a disabled button is drawn faded, which would read as not visible. */}
      <div ref={guard.ref} className="grid grid-cols-2 gap-2">
        <Button variant={discourage ? "default" : "outline"} onClick={onCancel} disabled={busy} className={discourage ? primary : secondary} data-testid="cancel">
          Cancel
        </Button>
        <Button
          variant={discourage ? "outline" : "default"}
          onClick={approve}
          disabled={busy || disabled || !ready}
          className={discourage ? secondary : primary}
          data-testid="approve"
          data-guard={guard.state}
        >
          {busy ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              Waiting for passkey…
            </>
          ) : approveLabel}
        </Button>
      </div>
      {guard.state === "not-visible" && !busy && (
        <p className="text-[10px] text-yellow-500 text-center leading-tight">
          This window is covered or not fully visible. Make sure nothing is on top of it to continue.
        </p>
      )}
    </div>
  )
}
