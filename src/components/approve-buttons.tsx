import type { CSSProperties, MouseEvent, ReactNode } from "react"
import { buttonClass, type ButtonTone } from "@/lib/ui"
import { ARM_DELAY_MS, useActivationGuard, type ActivationGuard } from "@/security/gesture"
import { Actions, PlainButton } from "@/components/sheet"

/**
 * A button that approves or signs. It acts only on a real, visible click
 * (see security/gesture): disabled while it arms (a thin bar fills inside
 * it), and while the window is covered, partly off screen or too small.
 */
export function GuardedButton({
  label,
  onActivate,
  framed,
  active,
  tone = "primary",
  delayMs = ARM_DELAY_MS,
  testId = "approve",
}: {
  label: ReactNode
  onActivate: () => void
  framed: boolean
  /** False while it is off for another reason (an unticked box, a preview still loading). */
  active: boolean
  tone?: ButtonTone
  delayMs?: number
  testId?: string
}) {
  const guard = useActivationGuard({ framed, active, delayMs })
  return <GuardedButtonView guard={guard} label={label} onActivate={onActivate} active={active} tone={tone} delayMs={delayMs} testId={testId} />
}

function GuardedButtonView({
  guard,
  label,
  onActivate,
  active,
  tone,
  delayMs,
  testId,
}: {
  guard: ActivationGuard
  label: ReactNode
  onActivate: () => void
  active: boolean
  tone: ButtonTone
  delayMs: number
  testId: string
}) {
  const ready = guard.state === "ready"
  const hidden = guard.state === "not-visible"
  const arming = guard.state === "arming" && active
  const click = (event: MouseEvent<HTMLButtonElement>) => {
    if (!ready || !guard.canActivate(event.nativeEvent)) return
    onActivate()
  }
  return (
    <button
      type="button"
      onClick={click}
      disabled={!active || !ready}
      className={`relative overflow-hidden ${buttonClass(tone)}`}
      data-testid={testId}
      data-guard={guard.state}
      aria-describedby={arming ? `${testId}-arming` : undefined}
    >
      {hidden ? "Make this window fully visible" : label}
      {arming && (
        <>
          <span
            className="lk-arming-bar absolute inset-x-0 bottom-0 h-1 bg-current opacity-60"
            style={{ "--lk-arm-ms": `${delayMs}ms` } as CSSProperties}
            aria-hidden="true"
          />
          <span id={`${testId}-arming`} className="sr-only">
            Ready in a moment
          </span>
        </>
      )}
    </button>
  )
}

/** Shown while the decision surface is covered, partly off screen, or too small to show whole. */
export function NotVisibleNotice() {
  return (
    <p className="text-center text-[14px] leading-[20px] text-ink" data-testid="not-visible">
      LazorKit only accepts approvals when its whole window is visible. Scroll, or close what covers it.
    </p>
  )
}

interface ApproveButtonsProps {
  onApprove: () => void
  onCancel: () => void
  framed: boolean
  /** Further reason to keep Approve off (an unticked confirmation, a preview still loading). */
  disabled?: boolean
  approveLabel?: ReactNode
  cancelLabel?: string
  /**
   * Cancel is the recommended action (a likely failure, a change LazorKit
   * can't show): Cancel solid on the right, Approve a plain button on the left.
   */
  recommendCancel?: boolean
  /** Approve in the danger text style (a danger screen's confirmation step). */
  approveTone?: ButtonTone
  delayMs?: number
  /** The caption line under the buttons. */
  caption?: ReactNode
}

/** Cancel and Approve, in the sticky zone; Approve acts only on a real, visible click. */
export function ApproveButtons({
  onApprove,
  onCancel,
  framed,
  disabled = false,
  approveLabel = "Approve with passkey",
  cancelLabel = "Cancel",
  recommendCancel = false,
  approveTone,
  delayMs = ARM_DELAY_MS,
  caption,
}: ApproveButtonsProps) {
  const guard = useActivationGuard({ framed, active: !disabled, delayMs })
  const approve = (
    <GuardedButtonView
      guard={guard}
      label={approveLabel}
      onActivate={onApprove}
      active={!disabled}
      tone={approveTone ?? (recommendCancel ? "secondary" : "primary")}
      delayMs={delayMs}
      testId="approve"
    />
  )
  const cancel = (
    <PlainButton onClick={onCancel} tone={recommendCancel ? "primary" : "secondary"} testId="cancel">
      {cancelLabel}
    </PlainButton>
  )
  return (
    <Actions caption={guard.state === "not-visible" ? <NotVisibleNotice /> : caption}>
      {recommendCancel ? (
        <>
          {approve}
          {cancel}
        </>
      ) : (
        <>
          {cancel}
          {approve}
        </>
      )}
    </Actions>
  )
}
