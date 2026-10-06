import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { policy, registry } from "@/config"
import { ApprovalReview, LEGACY_TITLE } from "@/components/approval-review"
import { MessageReview } from "@/components/message-review"
import { Refusal } from "@/components/refusal"
import { AppIdentity, TopBar, type RequesterView } from "@/components/requester-bar"
import { HERO_ID, type Row } from "@/components/sheet"
import { Cancelled, CheckingRequester, Closed, Ended, PasskeyWaiting, Receipt, SignedIn, Undelivered, type Approving } from "@/components/status"
import { TransactionReview } from "@/components/transaction-review"
import { WalletConnection } from "@/components/wallet-connection"
import { refusalText } from "@/security/refusal-text"
import { refusalScreen } from "@/security/refusal-screen"
import { toHex } from "@/security/encoding"
import { originHost, sameSite } from "@/security/domain"
import { browserFamily, isFramed, requesterInput, watchParentMessages } from "@/security/environment"
import { DecisionSurface, supportsVisibilityTracking } from "@/security/gesture"
import type { ParentMessage } from "@/security/handshake"
import { badgeExplainer, whoIsAsking } from "@/security/identity"
import { readPortalRequest } from "@/security/params"
import type { Subject } from "@/security/policy"
import { checkRedirect, destinationLabel } from "@/security/redirect"
import { appForOrigin } from "@/security/registry"
import { evaluateRequest } from "@/security/request"
import { resolveRequester } from "@/security/requester"
import { redirectUrlFor, refusalRoute, routeFor, sendReply, type ConnectedResult, type PortalResult, type ReplyRoute, type ReplyWindow } from "@/security/reply"
import { buildEvent, sendEvent, type Outcome, type VisibilityTracking } from "@/security/telemetry"
import { usePreview, type PreviewState } from "@/pages/use-preview"
import { parseCluster, type ResolvedCluster } from "@/utils/cluster"
import { paymentHero } from "@/utils/preview"
import { approvedBefore, rememberApproval } from "@/utils/storage"
import { ceremonyErrorText, signChallenge } from "@/utils/webauthn"

/** How long to wait for the embedding page's first message before saying the requester is unknown. */
const SETTLE_MS = 4000
/** When the decision is reported, so evidence that arrives just after load is included. */
const REPORT_AFTER_MS = 1500
/**
 * How long a popup stays open after posting its answer. The SDK takes a
 * message only from the popup it opened, and stops listening once it sees
 * that popup closed; closing at once could land before the message is read.
 */
const POPUP_CLOSE_AFTER_MS = 300

type Phase = "review" | "busy" | "cancelled" | "done" | "undelivered" | "closed"

const replyWindow: ReplyWindow = {
  get parent() {
    return isFramed() ? window.parent : null
  },
  get opener() {
    return window.opener ?? null
  },
  close: () => window.setTimeout(() => window.close(), POPUP_CLOSE_AFTER_MS),
  navigate: (url) => window.location.assign(url),
}

/** A redirect destination as the screen shows it (see `destinationLabel`); null when it is not a URL. */
function redirectLabel(raw: string | null): string | null {
  if (!raw) return null
  try {
    return destinationLabel(new URL(raw))
  } catch {
    return null
  }
}

/** What is being approved, for the waiting, canceled and approved screens: the review's own hero. */
function approvingFor(subject: Subject | null, preview: PreviewState, name: string): Approving {
  switch (subject?.kind) {
    case "message":
      return { hero: "Sign a message", next: `The signature goes to ${name} only.` }
    case "message-without-text":
      return { hero: "Sign data", next: `The signature goes to ${name} only.` }
    case "ownership":
      return { hero: "Confirm it's you", next: `${name} takes it from here.` }
    case "approval":
      return { hero: LEGACY_TITLE, next: `${name} takes it from here.` }
    case "transaction": {
      const payment = preview.summary?.payment ?? null
      return payment
        ? { hero: paymentHero(payment), to: payment.to, amount: true, says: name, next: `${name} sends it now. Payments can't be undone.` }
        : { hero: "Approve this action", says: name, next: `${name} sends it now. It can't be undone.` }
    }
    default:
      return { hero: `Sign in to ${name}`, next: "" }
  }
}

export default function Home() {
  const request = useMemo(() => readPortalRequest(window.location.search), [])
  const framed = useMemo(() => isFramed(), [])
  // In a frame, whether the browser can report that the page is covered (see security/gesture).
  const visibility: VisibilityTracking = useMemo(() => (framed ? (supportsVisibilityTracking() ? "tracked" : "untracked") : "top-level"), [framed])
  const [surface, setSurface] = useState<HTMLElement | null>(null)
  const [messages, setMessages] = useState<readonly ParentMessage[]>([])
  const [settled, setSettled] = useState(false)
  const [phase, setPhase] = useState<Phase>("review")
  /** What was answered: the receipt shown after it. */
  const [answered, setAnswered] = useState<PortalResult["type"] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [network, setNetwork] = useState<ResolvedCluster | null>(null)
  // The longer passkey note: the first approval on this browser, and a retry.
  const [firstTime] = useState(() => !approvedBefore())
  const [retry, setRetry] = useState(false)

  useEffect(() => watchParentMessages(request.rid, setMessages), [request.rid])
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [])

  const requester = useMemo(() => resolveRequester(requesterInput(messages, request.redirectUrl)), [messages, request.redirectUrl])
  const redirect = useMemo(
    () =>
      requester.channel === "redirect" && request.redirectUrl
        ? checkRedirect(request.redirectUrl, { registry, policy: policy.redirects, requesterOrigin: requester.openedFrom })
        : undefined,
    [requester, request.redirectUrl],
  )
  const route = useMemo(() => routeFor(requester, redirect, request.redirectParam === "expo"), [requester, redirect, request.redirectParam])
  const evaluation = useMemo(() => evaluateRequest({ request, requester, redirect, registry, policy }), [request, requester, redirect])
  const { subject, decision } = evaluation

  const preview = usePreview(
    decision.outcome === "show" && subject?.kind === "transaction" ? subject.preview : null,
    parseCluster(request.clusterSimulation),
    setNetwork,
  )

  // Replies and checks read the latest evidence, which can change while a passkey prompt is open.
  const latest = useRef({ route, evaluation, requester, redirect, network })
  latest.current = { route, evaluation, requester, redirect, network }
  /** One answer per request: a reply already sent is never followed by another. */
  const replied = useRef(false)
  /** The answer as it went out, for "Back to <App>": the same answer, the same way, never another. */
  const delivered = useRef<{ route: ReplyRoute; result: PortalResult } | null>(null)
  const [deliveredBy, setDeliveredBy] = useState<ReplyRoute["channel"] | null>(null)
  /** Stops a passkey prompt that is still open when the request is canceled. */
  const ceremony = useRef<AbortController | null>(null)

  const reported = useRef(false)
  const report = useCallback((event: "request" | "result", outcome: Outcome, reason?: string) => {
    const now = latest.current
    sendEvent(
      buildEvent({
        policy,
        event,
        action: request.action,
        requester: now.requester,
        redirect: now.redirect,
        subject: now.evaluation.subject,
        decision: now.evaluation.decision,
        outcome,
        reason,
        cluster: now.network ? { cluster: now.network.cluster, source: now.network.source } : null,
        browser: browserFamily(),
        visibility,
      }),
    )
  }, [request.action, visibility])
  const reportRequest = useCallback(() => {
    if (reported.current) return
    reported.current = true
    const d = latest.current.evaluation.decision
    report("request", d.outcome === "show" ? "shown" : "refused")
  }, [report])
  useEffect(() => {
    const timer = window.setTimeout(reportRequest, REPORT_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [reportRequest])

  const finish = useCallback((result: PortalResult, outcome: Outcome, reason?: string, route: ReplyRoute = latest.current.route) => {
    if (replied.current) return
    replied.current = true
    reportRequest()
    const delivery = sendReply(route, result, replyWindow)
    report("result", delivery === "dropped" ? "undelivered" : outcome, reason)
    if (delivery !== "dropped") {
      delivered.current = { route, result }
      setDeliveredBy(route.channel)
    }
    setAnswered(result.type)
    setPhase(delivery === "dropped" ? "undelivered" : "done")
  }, [report, reportRequest])

  const cancel = useCallback(() => {
    ceremony.current?.abort()
    finish({ type: "error", code: "user-rejected", message: "User rejected the request" }, "rejected", "user-rejected")
  }, [finish])

  const approve = useCallback(async () => {
    const before = latest.current.evaluation
    if (before.decision.outcome !== "show" || !before.signBytes || !before.credential || replied.current) return
    const controller = new AbortController()
    ceremony.current = controller
    setPhase("busy")
    setError(null)
    try {
      const { credentialId, assertion } = await signChallenge(before.signBytes, before.credential, controller.signal)
      if (controller.signal.aborted) return
      // The requester must still be the one that was shown.
      if (latest.current.evaluation.decision.outcome !== "show") {
        setPhase("review")
        return
      }
      rememberApproval()
      finish({ type: "signed", credentialId, assertion, timestamp: Date.now() }, "approved")
    } catch (e) {
      if (controller.signal.aborted || replied.current) return
      setError(ceremonyErrorText(e))
      setPhase("cancelled")
    }
  }, [finish])

  const connected = useCallback((result: ConnectedResult) => {
    // The requester must still be the one that was shown.
    if (latest.current.evaluation.decision.outcome !== "show") return
    finish(result, "approved")
  }, [finish])

  /**
   * Back to the app after the answer went: a popup closes (the SDK has the
   * answer); a redirect goes to the same destination with the same answer,
   * for when the app didn't open. In a frame the SDK closes the dialog.
   */
  const backToApp = useCallback(() => {
    const sent = delivered.current
    if (!sent) return
    if (sent.route.channel === "redirect") replyWindow.navigate(redirectUrlFor(sent.route.url, sent.result, sent.route.legacyExpo))
    else if (sent.route.channel === "popup") window.close()
  }, [])
  const onBack = deliveredBy === "redirect" || deliveredBy === "popup" ? backToApp : undefined

  const closeRefusal = useCallback((reason: string) => {
    // Back to the requesting origin or a registered destination only.
    const route = refusalRoute(latest.current.route, latest.current.redirect)
    if (route.channel !== "none") {
      const { title, detail } = refusalText(reason)
      finish({ type: "error", code: reason, message: `${title}: ${detail}` }, "refused", reason, route)
      return
    }
    reportRequest()
    report("result", "refused", reason)
    if (requester.channel === "popup") window.close()
    setPhase("closed")
  }, [finish, report, reportRequest, requester.channel])

  // Escape is Cancel, on a request that is shown (an open address sheet takes it first).
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || replied.current) return
      if (latest.current.evaluation.decision.outcome !== "show") return
      if (phaseRef.current === "review" || phaseRef.current === "busy" || phaseRef.current === "cancelled") cancel()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [cancel])

  const app = requester.channel === "redirect" ? (redirect?.ok ? redirect.app : undefined) : appForOrigin(registry, requester.origin)
  const view: RequesterView = {
    channel: requester.channel,
    label: requester.channel === "redirect" ? redirectLabel(request.redirectUrl) : requester.origin,
    appName: app?.name,
    embeddedIn: requester.embeddedIn,
    openedFrom: requester.openedFrom,
    evidence: requester.evidence,
  }
  const who = whoIsAsking({ channel: view.channel, label: view.label, appName: view.appName })
  const name = who.name
  const approving = approvingFor(subject, preview, name)
  const explain = firstTime || retry
  // On the redirect channel, the site that opened the portal, when it isn't
  // the destination's own site: a caution where money or control is at stake.
  const openedElsewhere =
    requester.channel === "redirect" && requester.openedFrom && !sameSite(requester.openedFrom, who.origin)
      ? (originHost(requester.openedFrom) ?? requester.openedFrom)
      : null
  // Where the request came from, beyond the header: in Details on every screen.
  const context: Row[] = [
    ...(who.kind === "app" || who.destination ? [{ label: "Who's asking", value: badgeExplainer(who) }] : []),
    ...(requester.embeddedIn.length ? [{ label: "Opened inside", value: requester.embeddedIn.join(" › "), testId: "opened-inside" }] : []),
    ...(requester.openedFrom ? [{ label: "Opened from", value: requester.openedFrom, testId: "opened-from" }] : []),
  ]

  let hideRequester = false
  let body: ReactNode
  if (phase === "done") {
    body =
      answered === "connected" ? (
        <SignedIn name={name} onBack={onBack} />
      ) : answered === "signed" ? (
        <Receipt approving={approving} name={name} onBack={onBack} />
      ) : (
        <Ended name={name} refused={decision.outcome === "refuse"} onBack={onBack} />
      )
  } else if (phase === "undelivered") {
    body = <Undelivered name={name} />
  } else if (phase === "closed") {
    body = <Closed />
  } else if (decision.outcome === "refuse") {
    if (decision.reason === "requester-unknown" && !settled) {
      body = <CheckingRequester />
    } else {
      const screen = refusalScreen(decision.reason, name)
      hideRequester = !screen.showRequester
      const answers = refusalRoute(route, redirect).channel !== "none"
      body = <Refusal reason={decision.reason} screen={screen} closeLabel={answers ? `Back to ${name}` : "Close"} onClose={() => closeRefusal(decision.reason)} />
    }
  } else if (phase === "busy") {
    body = <PasskeyWaiting approving={approving} firstTime={firstTime} onCancel={cancel} />
  } else if (phase === "cancelled") {
    body = (
      <Cancelled
        approving={approving}
        name={name}
        error={error}
        payment={subject?.kind === "transaction"}
        onBack={cancel}
        onRetry={() => {
          setRetry(true)
          setPhase("review")
        }}
      />
    )
  } else if (subject?.kind === "sign-in" || (request.action === "connect" && subject?.kind === "ownership")) {
    body = <WalletConnection proof={subject.kind === "ownership" ? subject.challenge : null} who={who} context={context} framed={framed} onConnected={connected} onCancel={cancel} />
  } else if (subject?.kind === "message") {
    body = <MessageReview kind="message" text={subject.text} context={context} framed={framed} explain={explain} onApprove={approve} onCancel={cancel} />
  } else if (subject?.kind === "message-without-text") {
    body = <MessageReview kind="message-without-text" fingerprint={subject.fingerprint} context={context} framed={framed} explain={explain} onApprove={approve} onCancel={cancel} />
  } else if (subject?.kind === "ownership") {
    body = <ApprovalReview kind="ownership" name={name} context={context} framed={framed} explain={explain} onApprove={approve} onCancel={cancel} />
  } else if (subject?.kind === "approval") {
    body = (
      <ApprovalReview
        kind="approval"
        fingerprint={toHex(subject.challenge)}
        verified={who.kind === "site" && who.verified}
        caution={openedElsewhere ? `This request was opened from another site: ${openedElsewhere}.` : null}
        confirmRequired={visibility === "untracked"}
        name={name}
        context={context}
        framed={framed}
        explain={explain}
        onApprove={approve}
        onCancel={cancel}
      />
    )
  } else if (subject?.kind === "transaction") {
    body = (
      <TransactionReview
        preview={subject.preview}
        state={preview}
        who={who}
        app={app}
        embeddedIn={requester.embeddedIn}
        openedFrom={openedElsewhere}
        context={context}
        framed={framed}
        explain={explain}
        onApprove={approve}
        onCancel={cancel}
        confirmRequired={visibility === "untracked"}
      />
    )
  }

  // The page is the frame's height: the request scrolls inside it, and the
  // LazorKit bar, the requester and the buttons stay on screen. The surface
  // (everything inside main's padding, on every side, which also keeps it
  // clear of a frame's rounded corners and edges) is what the approve
  // buttons check is fully visible. In a frame too small to show the request at its minimum
  // height, the buttons fall below the surface, so reaching them scrolls
  // part of it off screen and Approve stays off.
  return (
    <div className="h-full w-full overflow-auto bg-surface text-ink" data-testid="page">
      <DecisionSurface.Provider value={surface}>
        <main className="mx-auto h-full w-full max-w-md px-4 pt-2 pb-4 min-[400px]:px-5">
          <div ref={setSurface} role="dialog" aria-modal="true" aria-labelledby={HERO_ID} className="flex h-full min-h-0 flex-col" data-testid="surface">
            <TopBar />
            <AppIdentity view={view} who={who} hidden={hideRequester} />
            <div className="flex min-h-0 flex-1 flex-col">{body}</div>
          </div>
        </main>
      </DecisionSurface.Provider>
    </div>
  )
}
