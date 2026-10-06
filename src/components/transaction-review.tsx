import { useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { AddressChip, AddressInline } from "@/components/address"
import { ApproveButtons } from "@/components/approve-buttons"
import { AppSays, Body, CautionRow, Details, Facts, Hero, PasskeyCaption, Sentence, type Row } from "@/components/sheet"
import type { Who } from "@/security/identity"
import type { RegisteredApp } from "@/security/registry"
import type { PreviewState } from "@/pages/use-preview"
import { copyText } from "@/utils/clipboard"
import { COMPUTE_BUDGET_PROGRAM, feeLine, MEMO_PROGRAM, MEMO_V1_PROGRAM, paymentHero, paymentWhat, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, unreadKind } from "@/utils/preview"

interface TransactionReviewProps {
  /** The transaction preview the request carried (base64). */
  preview: string
  state: PreviewState
  who: Who
  /** The registered app, for a fee payer registered to it. */
  app: RegisteredApp | undefined
  /** Sites the request passed through (a nested frame). */
  embeddedIn: readonly string[]
  /** On the redirect channel, the site that opened the portal, when it isn't the destination's own. */
  openedFrom: string | null
  /** Where the request came from (nested frames and the like), for Details. */
  context: readonly Row[]
  framed: boolean
  explain: boolean
  onApprove: () => void
  onCancel: () => void
  /** Ask for an explicit confirmation before Approve (a frame whose visibility can't be checked). */
  confirmRequired?: boolean
}

const PROGRAM_NAMES: Record<string, string> = {
  [SYSTEM_PROGRAM]: "System Program",
  [TOKEN_PROGRAM]: "Token Program",
  [TOKEN_2022_PROGRAM]: "Token-2022 Program",
  [COMPUTE_BUDGET_PROGRAM]: "Compute Budget Program",
  [MEMO_PROGRAM]: "Memo Program",
  [MEMO_V1_PROGRAM]: "Memo Program (v1)",
}

/**
 * A transaction with a preview. Until requests carry the signed preimage, the
 * preview is the app's claim: the hero says "<App> says", Details opens with
 * that, and there is no compare line. The hero names an amount only for a
 * preview that is one plain transfer; anything LazorKit didn't read is a
 * caution. From a requester that isn't verified, money moving is a caution.
 * The network is the preview's too, so it is named in Details only, as the
 * app's; a network other than the one the app asked for is a caution.
 */
export function TransactionReview({ preview, state, who, app, embeddedIn, openedFrom, context, framed, explain, onApprove, onCancel, confirmRequired = false }: TransactionReviewProps) {
  const [confirmed, setConfirmed] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const { loading, simulation, network, decoded, summary } = state
  const payment = summary?.payment ?? null

  // A failed simulation is a likely failure only on a network that is known;
  // on a guessed one it says nothing about the transaction.
  const simulationFailed = !!simulation?.error && !simulation.unavailable
  const failed = simulationFailed && network?.known === true
  const unconfirmed = simulationFailed && !failed
  const fee = summary ? feeLine({ feePayer: decoded?.feePayer ?? null, fees: summary.fees, app }) : null

  // What LazorKit didn't read: a whole preview it can't decode, a program, or a step of one it knows.
  const unread = decoded ? unreadKind(decoded) : "preview"

  // At most one caution, the most decisive first.
  let caution: string | null = null
  if (!loading) {
    const what = payment ? "this amount" : "what this does"
    if (failed) caution = "This will probably fail. Nothing leaves your account if it does."
    else if (network?.mismatch) {
      caution =
        network.cluster === "mainnet"
          ? `This uses real money, but ${who.name} asked for test mode.`
          : `This preview is for a test network, but ${who.name} asked for real money.`
    } else if (embeddedIn.length > 0) caution = `This request passed through another site: ${embeddedIn[0]}.`
    else if (openedFrom) caution = `This request was opened from another site: ${openedFrom}.`
    else if (!who.verified) {
      if (who.kind === "site" && who.destination) caution = `LazorKit can't tell which site sent this, or confirm ${what}.`
      else if (who.kind === "site" && who.host) caution = `${who.host} isn't verified, and LazorKit can't confirm ${what}.`
      else caution = `This app isn't verified, and LazorKit can't confirm ${what}.`
    } else if (unread === "service") caution = "Uses a service LazorKit can't read."
    else if (unread === "step") caution = "Includes a step LazorKit can't read."
    else if (unread === "preview") caution = "LazorKit can't read what this does."
  }

  const facts: Row[] = fee?.where === "first-view" ? [{ label: "Fee", value: fee.text, testId: "fee" }] : []

  const rows: Row[] = []
  if (payment) {
    rows.push({ label: "To", value: <AddressInline address={payment.to} /> })
    rows.push({ label: "Amount", value: paymentWhat(payment) })
  }
  if (fee?.where === "details") rows.push({ label: "Fee", value: fee.text, testId: "fee" })
  if (payment) rows.push({ label: "Undo", value: "Not possible. Payments are final." })
  if (simulation?.unavailable) rows.push({ label: "Estimate", value: "LazorKit couldn't get an estimate for this." })
  else if (unconfirmed) rows.push({ label: "Estimate", value: "LazorKit couldn't confirm which network this is for, so it couldn't check it." })
  else if (failed) rows.push({ label: "Estimate", value: "The estimate failed, so this will probably fail too." })
  else if (simulation && simulation.balanceChanges.length) {
    rows.push({
      label: "Balance changes (estimate)",
      value: (
        <ul className="space-y-0.5">
          {simulation.balanceChanges.slice(0, 6).map((change, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-2">
              <AddressInline address={change.account} />
              <span>
                ≈ {change.amount} {change.token}
              </span>
            </li>
          ))}
        </ul>
      ),
    })
  }
  rows.push(...context)

  const networkName = network ? (network.cluster === "mainnet" ? "Solana Mainnet" : "Solana Devnet") : "Unknown"
  // Where the network comes from: the preview's blockhash, or the app's word.
  const networkSource = !network
    ? ""
    : network.verified
      ? ` (from ${who.name}'s preview)`
      : network.source === "request"
        ? ` (as ${who.name} asked; not confirmed)`
        : " (not confirmed)"
  const experts: Row[] = [
    {
      label: "Network",
      value: (
        <span data-testid="network" data-cluster={network?.cluster} data-verified={network?.verified ? "true" : "false"} data-known={network?.known ? "true" : "false"}>
          {networkName}
          {networkSource}
          {network?.mismatch ? `. The app asked for ${network.cluster === "mainnet" ? "devnet" : "mainnet"}, but this transaction is for ${network.cluster}.` : ""}
        </span>
      ),
    },
  ]
  if (decoded?.feePayer) experts.push({ label: "Fee payer", value: <AddressInline address={decoded.feePayer} /> })
  if (payment?.toIsOwner) experts.push({ label: "Receiving token account", value: "Owned by the address above" })
  if (payment?.mint) experts.push({ label: "Token", value: <AddressInline address={payment.mint} /> })
  if (decoded) {
    const notRead = decoded.unread.length ? `, ${decoded.unread.length} LazorKit didn't read` : ""
    experts.push({ label: "Instructions", value: <span data-testid="instructions">{`${decoded.instructions}${notRead}`}</span> })
  }
  if (decoded?.programs.length) experts.push({ label: "Programs", value: decoded.programs.map((p) => PROGRAM_NAMES[p] ?? `${p.slice(0, 4)}…${p.slice(-4)}`).join(" · ") })
  if (simulation?.error) experts.push({ label: "Simulation", value: simulation.error })

  let hero: ReactNode
  if (loading) {
    hero = (
      <span className="flex items-center gap-2 text-ink-2" data-testid="checking">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        Checking…
      </span>
    )
  } else if (payment) {
    hero = paymentHero(payment)
  } else {
    hero = "Approve this action"
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="transaction-review"
      data-cluster={network?.cluster}
      data-loading={loading ? "true" : "false"}
    >
      <Body>
        <Hero eyebrow={<AppSays name={who.name} testId="preview-source" />} size={payment ? "amount" : "action"}>
          {hero}
        </Hero>
        {payment && <AddressChip address={payment.to} prefix="to" testId="recipient" />}
        {caution && <CautionRow testId={failed ? "simulation-failed" : "caution"}>{caution}</CautionRow>}
        {!loading && !failed && <Sentence>{payment ? "Payments can't be undone." : "Approved actions can't be undone."}</Sentence>}
        <Facts rows={facts} />
        {confirmRequired && !loading && (
          <label className="flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-[16px] leading-[24px] text-ink">
            <input type="checkbox" className="mt-0.5 h-6 w-6 shrink-0 accent-[var(--accent)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="confirm" />
            I started this on {who.name}.
          </label>
        )}
        <Details
          lead={
            <p className="py-2 text-[14px] leading-[20px] text-ink-2" data-testid="preview-notice">
              Preview from {who.name}. LazorKit can't yet confirm it matches what you sign.
            </p>
          }
          rows={rows}
          experts={experts}
        >
          <div className="pt-1">
            <button
              type="button"
              className="min-h-11 text-[14px] text-ink underline underline-offset-4"
              onClick={async () => setCopied((await copyText(preview)) ? "Transaction copied" : "Couldn't copy the transaction.")}
              data-testid="copy-transaction"
            >
              Copy transaction
            </button>
            <span role="status" className="ml-2 text-[14px] text-ink-2">
              {copied}
            </span>
          </div>
        </Details>
      </Body>

      <ApproveButtons
        framed={framed}
        disabled={loading || (confirmRequired && !confirmed)}
        recommendCancel={failed}
        approveLabel={loading ? "Checking…" : failed ? "Approve anyway" : "Approve with passkey"}
        onApprove={onApprove}
        onCancel={onCancel}
        caption={<PasskeyCaption explain={explain} />}
      />
    </div>
  )
}
