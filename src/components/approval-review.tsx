import { useState } from "react"
import { ApproveButtons } from "@/components/approve-buttons"
import { Actions, Body, CautionRow, DangerBlock, Details, Hero, PasskeyCaption, PlainButton, Sentence, type Row } from "@/components/sheet"
import { buttonClass } from "@/lib/ui"
import { groupHex } from "@/security/display"
import { ACK_ARM_DELAY_MS } from "@/security/gesture"

type ApprovalReviewProps = {
  /** How sentences name the requester. */
  name: string
  /** Where the request came from (nested frames and the like), for Details. */
  context: readonly Row[]
  framed: boolean
  explain: boolean
  onApprove: () => void
  onCancel: () => void
} & (
  | {
      kind: "approval"
      fingerprint: string
      verified: boolean
      /**
       * Another site opened the request (the redirect channel): a caution on
       * the danger screen. A verified requester (a frame or a popup) never has one.
       */
      caution?: string | null
      /** Ask for an explicit confirmation before Approve (a frame whose visibility can't be checked). */
      confirmRequired?: boolean
    }
  | { kind: "ownership" }
)

export const LEGACY_TITLE = "Approve a change LazorKit can't show"
const LEGACY_RISK = "It could do anything, up to full control of your account."
const ACK = "I understand this could give away control of my account."

/**
 * A wallet change the app prepared, which LazorKit can't read yet (session,
 * key and similar requests from current SDKs): Cancel is the recommended
 * button. From a verified site it is a caution, with a box to tick in a
 * frame whose visibility can't be checked; from any other requester a
 * danger, and approving takes a confirmation step with a box to tick.
 *
 * Or a proof that the user holds this passkey, which approves nothing.
 */
export function ApprovalReview(props: ApprovalReviewProps) {
  const [ack, setAck] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  if (props.kind === "ownership") {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="approval-review" data-kind="ownership">
        <Body>
          <Hero>One more step</Hero>
          <Sentence>Use your passkey again so LazorKit can find your account. Nothing is paid.</Sentence>
          <Details
            rows={[
              {
                label: "Why again?",
                value: "LazorKit needs a second confirmation from the same passkey to find your account. You may be asked again on a new browser or in another app.",
              },
              { label: "Money", value: "Nothing is approved or paid." },
              ...props.context,
            ]}
          />
        </Body>
        <ApproveButtons framed={props.framed} approveLabel="Continue with passkey" onApprove={props.onApprove} onCancel={props.onCancel} caption={<PasskeyCaption />} />
      </div>
    )
  }

  const details = (
    <Details
      rows={[
        { label: "What it is", value: `${props.name}'s request doesn't say what it changes. LazorKit can't read this kind of request yet.` },
        { label: "Who decides", value: `Approve only if you fully trust ${props.name}.` },
        ...props.context,
      ]}
      experts={[{ label: "Fingerprint", value: <span data-testid="fingerprint">{groupHex(props.fingerprint)}</span> }]}
    />
  )

  if (props.verified) {
    const confirmRequired = props.confirmRequired ?? false
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="approval-review" data-kind="approval" data-tier="caution">
        <Body>
          <Hero>{LEGACY_TITLE}</Hero>
          <CautionRow>{LEGACY_RISK}</CautionRow>
          <Sentence>If you're not sure, cancel. Nothing happens.</Sentence>
          {confirmRequired && (
            <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-[16px] leading-[24px] text-ink">
              <input
                type="checkbox"
                className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--accent)]"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                data-testid="confirm"
              />
              I started this on {props.name}.
            </label>
          )}
          {details}
        </Body>
        <ApproveButtons
          framed={props.framed}
          recommendCancel
          disabled={confirmRequired && !confirmed}
          approveLabel="Approve anyway"
          onApprove={props.onApprove}
          onCancel={props.onCancel}
          caption={<PasskeyCaption explain={props.explain} />}
        />
      </div>
    )
  }

  // Danger: from a site that isn't verified, or an app LazorKit can't identify.
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="approval-review" data-kind="approval" data-tier="danger">
      <Body>
        <DangerBlock title={LEGACY_TITLE}>{LEGACY_RISK}</DangerBlock>
        {props.caution && <CautionRow>{props.caution}</CautionRow>}
        {ack && (
          <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-[16px] leading-[24px] text-ink" data-testid="ack-step">
            <input
              type="checkbox"
              className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--danger-text)]"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              data-testid="confirm"
            />
            {ACK}
          </label>
        )}
        {details}
      </Body>
      {ack ? (
        <ApproveButtons
          framed={props.framed}
          recommendCancel
          disabled={!confirmed}
          delayMs={ACK_ARM_DELAY_MS}
          approveLabel="Approve with passkey"
          onApprove={props.onApprove}
          onCancel={props.onCancel}
          caption={<PasskeyCaption explain={props.explain} />}
        />
      ) : (
        <Actions>
          <button type="button" className={buttonClass("danger-text")} onClick={() => setAck(true)} data-testid="approve-anyway">
            Approve anyway…
          </button>
          <PlainButton tone="primary" onClick={props.onCancel} testId="cancel">
            Cancel
          </PlainButton>
        </Actions>
      )}
    </div>
  )
}
