import { useMemo } from "react"
import { ApproveButtons } from "@/components/approve-buttons"
import { Body, CautionRow, Details, Hero, MatchLine, PasskeyCaption, Sentence, type Row } from "@/components/sheet"
import { groupHex, revealHidden } from "@/security/display"

type MessageReviewProps = {
  /** Where the request came from (nested frames and the like), for Details. */
  context: readonly Row[]
  framed: boolean
  /** Show the longer passkey caption (first approval here, or a retry). */
  explain: boolean
  onApprove: () => void
  onCancel: () => void
} & ({ kind: "message"; text: string } | { kind: "message-without-text"; fingerprint: string })

const NO_PAYMENT = "This can't approve a payment from your account."

/**
 * A message to sign: its exact text, with hidden characters shown as
 * labelled markers (never applied); or, for bytes that are not text, a
 * caution and the fingerprint in Details.
 */
export function MessageReview(props: MessageReviewProps) {
  const shown = useMemo(() => (props.kind === "message" ? revealHidden(props.text) : null), [props])
  const caption = <PasskeyCaption explain={props.explain} />

  if (props.kind === "message-without-text") {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="message-review" data-kind={props.kind}>
        <Body>
          <Hero>Sign data</Hero>
          <CautionRow>This data can't be shown as text. Sign only if you expected it.</CautionRow>
          <Sentence>{NO_PAYMENT}</Sentence>
          <Details
            rows={[{ label: "Format", value: "Data that isn't text, signed with a LazorKit message prefix" }, ...props.context]}
            experts={[{ label: "Fingerprint", value: <span data-testid="fingerprint">{groupHex(props.fingerprint)}</span> }]}
          />
        </Body>
        <ApproveButtons framed={props.framed} approveLabel="Sign with passkey" onApprove={props.onApprove} onCancel={props.onCancel} caption={caption} />
      </div>
    )
  }

  const hidden = shown?.segments.filter((s) => s.kind === "hidden") ?? []
  const labels = [...new Set(hidden.map((s) => (s.kind === "hidden" ? s.label : "")))]
  const caution =
    hidden.length === 0
      ? null
      : shown && shown.directional > 0
        ? `${hidden.length === 1 ? "A hidden character changes" : "Hidden characters change"} how this reads. Don't sign unless you know why.`
        : `This message has ${hidden.length === 1 ? "a hidden character" : "hidden characters"}. Don't sign unless you know why.`

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="message-review" data-kind={props.kind}>
      <Body>
        <Hero>Sign a message</Hero>
        <div
          tabIndex={0}
          role="region"
          aria-label="Message to sign"
          className="max-h-[9.75rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-ground p-3 font-mono text-[15px] leading-[22px] text-ink"
          dir="ltr"
          data-testid="message-text"
        >
          {shown?.segments.map((segment, i) =>
            segment.kind === "text" ? (
              <bdi key={i}>{segment.text}</bdi>
            ) : (
              <span
                key={i}
                className="mx-0.5 inline-block rounded border border-caution-line px-1 font-sans text-[13px] leading-[18px] text-ink"
                data-testid="hidden-char"
                data-code={segment.code}
              >
                <span aria-hidden="true">[{segment.label} ▸]</span>
                <span className="sr-only">hidden character: {segment.name}</span>
              </span>
            ),
          )}
        </div>
        {caution && <CautionRow>{caution}</CautionRow>}
        <Sentence>{NO_PAYMENT}</Sentence>
        <Details
          lead={<MatchLine />}
          rows={[
            ...(hidden.length ? [{ label: "Hidden characters", value: `${hidden.length}, shown as ${labels.map((l) => `[${l} ▸]`).join(", ")}` }] : []),
            { label: "Format", value: "Text, signed with a LazorKit message prefix" },
            ...props.context,
          ]}
          experts={hidden.map((s) => (s.kind === "hidden" ? { label: "Hidden character", value: `${s.code} (${s.name}) at position ${s.position}` } : { label: "", value: "" }))}
        />
      </Body>
      <ApproveButtons framed={props.framed} approveLabel="Sign with passkey" onApprove={props.onApprove} onCancel={props.onCancel} caption={caption} />
    </div>
  )
}
