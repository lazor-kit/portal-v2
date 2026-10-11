import { useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { ApproveButtons } from "@/components/approve-buttons"
import { Actions, Body, CautionBlock, CautionRow, DangerBlock, Details, Facts, Hero, MatchLine, PasskeyCaption, PlainButton, Sentence, TestChip, type Row } from "@/components/sheet"
import { buttonClass } from "@/lib/ui"
import { ACK_ARM_DELAY_MS } from "@/security/gesture"
import type { TextRow, TypedScreen } from "@/typed/screen"

interface TypedReviewProps {
  /** Null while LazorKit reads the chain. */
  screen: TypedScreen | null
  cluster: "devnet" | "mainnet"
  /** Where the request came from (nested frames and the like), for Details. */
  context: readonly Row[]
  framed: boolean
  explain: boolean
  /** Ask for an explicit confirmation before Approve (a frame whose visibility can't be checked). */
  confirmRequired: boolean
  /** How sentences name the requester. */
  name: string
  /** The latest snapshot of the chain is fresh enough to sign from. */
  canSign: boolean
  onApprove: () => void
  onCancel: () => void
}

function rows(list: readonly TextRow[]): Row[] {
  return list.map((r) => ({
    label: r.label,
    value: r.note ? (
      <>
        <span className="block whitespace-pre-line">{r.value}</span>
        <span className="block text-[14px] leading-[20px] text-ink-2">{r.note}</span>
      </>
    ) : (
      <span className="whitespace-pre-line">{r.value}</span>
    ),
    testId: r.testId,
  }))
}

/** The first view's main block: a caution or danger block, or the eyebrow, hero and the line under it. */
export function TypedHead({ screen }: { screen: Pick<TypedScreen, "eyebrow" | "hero" | "heroSize" | "block"> & { heroLine?: string | null } }) {
  if (screen.block) {
    const Block = screen.block.tier === "danger" ? DangerBlock : CautionBlock
    return (
      <Block title={screen.block.title} testId={screen.block.tier === "danger" ? "danger" : "caution-block"}>
        <span data-testid="block-body">{screen.block.body}</span>
      </Block>
    )
  }
  return (
    <div className="space-y-1">
      <Hero size={screen.heroSize} eyebrow={screen.eyebrow ? <p className="text-[15px] leading-[20px] font-bold text-ink-2" data-testid="eyebrow">{screen.eyebrow}</p> : undefined}>
        {screen.hero}
      </Hero>
      {screen.heroLine && (
        <p className="text-[16px] leading-[24px] text-ink" data-testid="hero-line">
          {screen.heroLine}
        </p>
      )}
    </div>
  )
}

/**
 * A typed request: what the passkey approves, read from the signed bytes and
 * from Solana (DESIGN §5). Details opens with the match line: LazorKit
 * recomputed what will be signed from what this screen shows.
 */
export function TypedReview({ screen, cluster, context, framed, explain, confirmRequired, name, canSign, onApprove, onCancel }: TypedReviewProps) {
  const [ack, setAck] = useState(false)
  const [acked, setAcked] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  if (!screen) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="typed-review" data-loading="true">
        <Body>
          <Hero>
            <span className="flex items-center gap-2 text-ink-2" data-testid="checking">
              <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
              Checking…
            </span>
          </Hero>
        </Body>
        <ApproveButtons framed={framed} disabled approveLabel="Checking…" onApprove={onApprove} onCancel={onCancel} caption={<PasskeyCaption explain={explain} />} />
      </div>
    )
  }

  const danger = screen.tier === "danger"
  const confirmBox: ReactNode = confirmRequired && !danger && (
    <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-[16px] leading-[24px] text-ink">
      <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--accent)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="confirm" />
      I started this on {name}.
    </label>
  )
  const approveLabel = canSign ? screen.approveLabel : "Checking the network…"

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="typed-review" data-screen={screen.id} data-variant={screen.variant ?? ""} data-tier={screen.tier} data-loading="false">
      <Body>
        <TypedHead screen={screen} />
        {cluster === "devnet" && <TestChip />}
        {screen.caution && <CautionRow>{screen.caution}</CautionRow>}
        {screen.sentence && <Sentence testId="sentence">{screen.sentence}</Sentence>}
        <Facts rows={rows(screen.facts)} />
        {confirmBox}
        {danger && ack && (
          <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-[16px] leading-[24px] text-ink" data-testid="ack-step">
            <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--danger-text)]" checked={acked} onChange={(e) => setAcked(e.target.checked)} data-testid="confirm" />
            {screen.ack}
          </label>
        )}
        <Details lead={<MatchLine />} rows={[...rows(screen.details), ...context]} experts={rows(screen.experts)} />
      </Body>
      {danger && !ack ? (
        <Actions>
          <button type="button" className={buttonClass("danger-text")} onClick={() => setAck(true)} data-testid="approve-anyway">
            Approve anyway…
          </button>
          <PlainButton tone="primary" onClick={onCancel} testId="cancel">
            {screen.cancelLabel}
          </PlainButton>
        </Actions>
      ) : (
        <ApproveButtons
          framed={framed}
          recommendCancel={screen.recommendCancel}
          disabled={!canSign || (danger ? !acked : confirmRequired && !confirmed)}
          delayMs={danger ? ACK_ARM_DELAY_MS : undefined}
          approveLabel={approveLabel}
          cancelLabel={screen.cancelLabel}
          onApprove={onApprove}
          onCancel={onCancel}
          caption={<PasskeyCaption explain={explain} />}
        />
      )}
    </div>
  )
}
