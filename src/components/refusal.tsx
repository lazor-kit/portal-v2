import { Ban } from "lucide-react"
import { Actions, Body, Details, Hero, Note, PlainButton, Sentence, StatusMark } from "@/components/sheet"
import type { RefusalScreen } from "@/security/refusal-screen"

interface RefusalProps {
  reason: string
  screen: RefusalScreen
  /** "Back to Fernway" when the answer goes back to the requester; "Close" otherwise. */
  closeLabel: string
  onClose: () => void
  /** "Try again", where the screen offers it (a read that failed). */
  onRetry?: () => void
}

/** A request LazorKit didn't show: what happened, in plain words, and that the passkey signed nothing. */
export function Refusal({ reason, screen, closeLabel, onClose, onRetry }: RefusalProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="refusal" data-reason={reason} data-kind={screen.kind}>
      <Body testId="refusal-content">
        <StatusMark>
          <Ban className="h-6 w-6" aria-hidden="true" />
        </StatusMark>
        <Hero>{screen.hero}</Hero>
        <Sentence testId="refusal-sentence">{screen.sentence}</Sentence>
        {screen.note && <Note>{screen.note}</Note>}
        <Details rows={screen.details} experts={screen.experts} />
      </Body>
      {screen.retry && onRetry ? (
        <Actions>
          <PlainButton onClick={onClose} testId="close">
            {closeLabel}
          </PlainButton>
          <PlainButton tone="primary" onClick={onRetry} testId="try-again">
            Try again
          </PlainButton>
        </Actions>
      ) : (
        <Actions single>
          <PlainButton tone="primary" onClick={onClose} testId="close">
            {closeLabel}
          </PlainButton>
        </Actions>
      )}
    </div>
  )
}
