import { Ban, Check, KeyRound, Loader2, X } from "lucide-react"
import { AddressChip, ShortAddress } from "@/components/address"
import { Actions, AppSays, Body, Caption, Details, Facts, Hero, Note, PlainButton, Sentence, StatusMark, TestChip } from "@/components/sheet"
import { TypedHead } from "@/components/typed-review"
import type { TypedScreen } from "@/typed/screen"

/** What is being approved, as the review showed it: the same hero on the waiting, canceled and approved screens. */
export interface Approving {
  readonly hero: string
  /** The recipient of a payment. */
  readonly to?: string
  /** The hero is an amount ("Send 0.25 SOL"). */
  readonly amount?: boolean
  /** The hero is the app's claim (a transaction preview): "<App> says". */
  readonly says?: string
  /** The receipt's sentence: what happens next. */
  readonly next: string
  /** A typed request: the receipt repeats its card (and keeps its caution or danger block). */
  readonly typed?: TypedScreen["receipt"] & { readonly testNetwork: boolean }
}

/**
 * The device's passkey prompt is open. It may say "Sign in" whatever is
 * being approved, so this says so. Cancel stops the prompt and the request.
 */
export function PasskeyWaiting({
  approving,
  firstTime,
  signIn = false,
  onCancel,
}: {
  approving: Pick<Approving, "hero" | "to">
  firstTime: boolean
  /** Signing in or creating a passkey: a QR code there usually means no passkey here. */
  signIn?: boolean
  onCancel: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="passkey-waiting">
      <Body testId="waiting-content">
        <div role="status" aria-live="polite" className="space-y-3">
          <StatusMark>
            <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          </StatusMark>
          <Hero>Waiting for your device</Hero>
          <p className="text-[16px] leading-[24px] text-ink-2">
            {approving.hero}
            {approving.to && (
              <>
                {" "}
                to <ShortAddress address={approving.to} />
              </>
            )}
          </p>
        </div>
        <Sentence>
          {signIn
            ? "Seeing a QR code or “another device”? You may not have a passkey here yet. Close it to create one."
            : "It may say “Sign in”. That's this approval."}
        </Sentence>
        {firstTime && !signIn && <Note>LazorKit never sees your face or fingerprint.</Note>}
        <Note>Can't see it? Look behind this window.</Note>
      </Body>
      <Actions single>
        <PlainButton onClick={onCancel} testId="cancel">
          Cancel
        </PlainButton>
      </Actions>
    </div>
  )
}

/** The passkey step didn't finish: nothing was signed. Try again goes back to the request. */
export function Cancelled({
  approving,
  name,
  error,
  payment,
  onBack,
  onRetry,
}: {
  approving: Pick<Approving, "hero" | "to">
  name: string
  error: string | null
  payment: boolean
  onBack: () => void
  onRetry: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="cancelled">
      <Body testId="cancelled-content">
        <StatusMark>
          <X className="h-6 w-6" aria-hidden="true" />
        </StatusMark>
        <Hero>Nothing was approved</Hero>
        <p className="text-[16px] leading-[24px] text-ink-2">
          {approving.hero}
          {approving.to && (
            <>
              {" "}
              to <ShortAddress address={approving.to} />
            </>
          )}
        </p>
        <Sentence>
          {payment ? "The passkey step didn't finish, so nothing left your account." : "The passkey step didn't finish, so nothing was signed."}
        </Sentence>
        {error && <Details rows={[{ label: "What your device said", value: error, testId: "ceremony-error" }]} />}
      </Body>
      <Actions>
        <PlainButton onClick={onBack} testId="back">
          Back to {name}
        </PlainButton>
        <PlainButton tone="primary" onClick={onRetry} testId="try-again">
          Try again
        </PlainButton>
      </Actions>
    </div>
  )
}

/**
 * The way back once the answer has gone: "Back to <App>" where the page can
 * take the user there itself (a popup closes, a redirect goes to the same
 * answer's address again); in a frame the app closes the dialog, so there is
 * only the caption.
 */
function Returning({ name, onBack }: { name: string; onBack?: () => void }) {
  return (
    <Actions single caption={<Caption testId="returning" passkey={false}>Returning you to {name}…</Caption>}>
      {onBack && (
        <PlainButton tone="primary" onClick={onBack} testId="back-to-app">
          Back to {name}
        </PlainButton>
      )}
    </Actions>
  )
}

/**
 * Approved: the same card as the request, marked "You approved". LazorKit
 * doesn't send anything, so it never says "Sent".
 */
export function Receipt({ approving, name, onBack }: { approving: Approving; name: string; onBack?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="done">
      <Body testId="done-content">
        <p className="flex items-center gap-1.5 text-[15px] leading-[20px] font-bold text-ink" data-testid="approved-stamp">
          <Check className="h-4 w-4" aria-hidden="true" />
          You approved
        </p>
        {approving.typed ? (
          <>
            <TypedHead screen={approving.typed} />
            {approving.typed.testNetwork && <TestChip />}
          </>
        ) : (
          <Hero size={approving.amount ? "amount" : "action"} eyebrow={approving.says ? <AppSays name={approving.says} /> : undefined}>
            {approving.hero}
          </Hero>
        )}
        {approving.to && <AddressChip address={approving.to} prefix="to" testId="recipient" />}
        <Sentence testId="receipt-next">{approving.next}</Sentence>
        {approving.typed && <Facts rows={approving.typed.facts.map((f) => ({ label: f.label, value: f.value }))} />}
      </Body>
      <Returning name={name} onBack={onBack} />
    </div>
  )
}

/** Signed in: the sign-in's receipt. */
export function SignedIn({ name, onBack }: { name: string; onBack?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="done">
      <Body testId="done-content">
        <StatusMark>
          <KeyRound className="h-6 w-6" aria-hidden="true" />
        </StatusMark>
        <Hero>You're signed in to {name}</Hero>
      </Body>
      <Returning name={name} onBack={onBack} />
    </div>
  )
}

/** Canceled, or refused: the answer went back, and nothing was signed. */
export function Ended({ name, refused, onBack }: { name: string; refused: boolean; onBack?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="ended">
      <Body testId="ended-content">
        <StatusMark>
          {refused ? <Ban className="h-6 w-6" aria-hidden="true" /> : <X className="h-6 w-6" aria-hidden="true" />}
        </StatusMark>
        <Hero>{refused ? "Request stopped" : "Nothing was approved"}</Hero>
        <Sentence>Your passkey signed nothing.</Sentence>
      </Body>
      <Returning name={name} onBack={onBack} />
    </div>
  )
}

/** The answer could not be posted back (the requesting window is gone). */
export function Undelivered({ name }: { name: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="undelivered">
      <Body testId="undelivered-content">
        <StatusMark>
          <Ban className="h-6 w-6" aria-hidden="true" />
        </StatusMark>
        <Hero>The answer didn't reach {name}</Hero>
        <Sentence>Close this window and try again from the app.</Sentence>
      </Body>
    </div>
  )
}

/** A refusal with nowhere to send it. */
export function Closed() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="closed">
      <Body testId="closed-content">
        <Hero>You can close this window</Hero>
        <Sentence>Close it to return to the app. Your passkey signed nothing.</Sentence>
      </Body>
    </div>
  )
}

/** Waiting for the embedding page to say who it is, before deciding. */
export function CheckingRequester() {
  return (
    <div className="flex flex-col items-center gap-2 py-10" data-testid="waiting" role="status" aria-live="polite">
      <Loader2 className="h-6 w-6 animate-spin text-ink-2" aria-hidden="true" />
      <p className="text-[14px] leading-[20px] text-ink-2">Checking which site opened this…</p>
    </div>
  )
}
