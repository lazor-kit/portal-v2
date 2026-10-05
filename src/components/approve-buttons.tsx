import { Loader2 } from "lucide-react"
import type { MouseEvent } from "react"
import { Button } from "@/components/ui/button"
import { useActivationGuard } from "@/security/gesture"

interface ApproveButtonsProps {
  onApprove: () => void
  onCancel: () => void
  framed: boolean
  busy?: boolean
  /** Further reason to keep Approve off (an unticked confirmation, a preview still loading). */
  disabled?: boolean
  approveLabel?: string
  /** Approve as the secondary button, Cancel as the primary (a failed simulation). */
  discourage?: boolean
}

/** Cancel and Approve; Approve acts only on a real, visible click (see security/gesture). */
export function ApproveButtons({ onApprove, onCancel, framed, busy = false, disabled = false, approveLabel = "Approve", discourage = false }: ApproveButtonsProps) {
  const guard = useActivationGuard({ framed, active: !busy && !disabled })
  const ready = guard.state === "ready"

  const approve = (event: MouseEvent<HTMLButtonElement>) => {
    if (!ready || !guard.canActivate(event.nativeEvent)) return
    onApprove()
  }

  const secondary = "w-full bg-muted/50 hover:bg-muted text-foreground font-semibold py-2 rounded-lg h-10 text-sm border-border/50"
  const primary = "w-full font-semibold py-2 rounded-lg h-10 text-sm"

  return (
    <div className="shrink-0 space-y-1.5 pt-1">
      <div className="grid grid-cols-2 gap-2">
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
      {guard.state === "not-visible" && !busy && <NotVisibleNotice />}
    </div>
  )
}

/** Shown while the decision surface is covered, partly off screen, or too small to show whole. */
export function NotVisibleNotice() {
  return (
    <p className="text-[10px] text-yellow-500 text-center leading-tight" data-testid="not-visible">
      This window is covered, partly off screen, or too small. Make sure all of it is visible to continue.
    </p>
  )
}
