import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { CheckCircle2, Loader2 } from "lucide-react"
import { policy, registry } from "@/config"
import { ApprovalReview } from "@/components/approval-review"
import { MessageReview } from "@/components/message-review"
import { Refusal } from "@/components/refusal"
import { refusalText } from "@/security/refusal-text"
import { RequesterBar, type RequesterView } from "@/components/requester-bar"
import { TransactionReview } from "@/components/transaction-review"
import { WalletConnection } from "@/components/wallet-connection"
import { toHex } from "@/security/encoding"
import { browserFamily, isFramed, requesterInput, watchParentMessages } from "@/security/environment"
import type { ParentMessage } from "@/security/handshake"
import { readPortalRequest } from "@/security/params"
import { checkRedirect } from "@/security/redirect"
import { appForOrigin } from "@/security/registry"
import { evaluateRequest } from "@/security/request"
import { resolveRequester } from "@/security/requester"
import { routeFor, sendReply, type PortalResult, type ReplyWindow } from "@/security/reply"
import { buildEvent, sendEvent, type Outcome } from "@/security/telemetry"
import { parseCluster, type ResolvedCluster } from "@/utils/cluster"
import { ceremonyErrorText, signChallenge } from "@/utils/webauthn"

/** How long to wait for the embedding page's first message before saying the requester is unknown. */
const SETTLE_MS = 4000
/** When the decision is reported, so evidence that arrives just after load is included. */
const REPORT_AFTER_MS = 1500

type Phase = "review" | "busy" | "done" | "undelivered" | "closed"

const replyWindow: ReplyWindow = {
  get parent() {
    return isFramed() ? window.parent : null
  },
  get opener() {
    return window.opener ?? null
  },
  close: () => window.close(),
  navigate: (url) => window.location.assign(url),
}

/** `https://host` or `scheme://` of a URL, for display; null when it is not one. */
function destinationLabel(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : `${url.protocol}//`
  } catch {
    return null
  }
}

export default function Home() {
  const request = useMemo(() => readPortalRequest(window.location.search), [])
  const framed = useMemo(() => isFramed(), [])
  const [messages, setMessages] = useState<readonly ParentMessage[]>([])
  const [settled, setSettled] = useState(false)
  const [phase, setPhase] = useState<Phase>("review")
  const [error, setError] = useState<string | null>(null)
  const [network, setNetwork] = useState<ResolvedCluster | null>(null)

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

  // Replies and checks read the latest evidence, which can change while a passkey prompt is open.
  const latest = useRef({ route, evaluation, requester, redirect, network })
  latest.current = { route, evaluation, requester, redirect, network }

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
      }),
    )
  }, [request.action])
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

  const finish = useCallback((result: PortalResult, outcome: Outcome, reason?: string) => {
    reportRequest()
    const delivery = sendReply(latest.current.route, result, replyWindow)
    report("result", delivery === "dropped" ? "undelivered" : outcome, reason)
    setPhase(delivery === "dropped" ? "undelivered" : "done")
  }, [report, reportRequest])

  const cancel = useCallback(() => {
    finish({ type: "error", code: "user-rejected", message: "User rejected the request" }, "rejected", "user-rejected")
  }, [finish])

  const approve = useCallback(async () => {
    const before = latest.current.evaluation
    if (before.decision.outcome !== "show" || !before.signBytes || !before.credential) return
    setPhase("busy")
    setError(null)
    try {
      const { credentialId, assertion } = await signChallenge(before.signBytes, before.credential)
      // The requester must still be the one that was shown.
      if (latest.current.evaluation.decision.outcome !== "show") {
        setPhase("review")
        return
      }
      finish({ type: "signed", credentialId, assertion, timestamp: Date.now() }, "approved")
    } catch (e) {
      setError(ceremonyErrorText(e))
      setPhase("review")
    }
  }, [finish])

  const connected = useCallback((result: Extract<PortalResult, { type: "connected" }>) => {
    // The requester must still be the one that was shown.
    if (latest.current.evaluation.decision.outcome !== "show") return
    finish(result, "approved")
  }, [finish])

  const closeRefusal = useCallback((reason: string) => {
    if (latest.current.route.channel !== "none") {
      const { title, detail } = refusalText(reason)
      finish({ type: "error", code: reason, message: `${title}: ${detail}` }, "refused", reason)
      return
    }
    reportRequest()
    report("result", "refused", reason)
    if (requester.channel === "popup") window.close()
    setPhase("closed")
  }, [finish, report, reportRequest, requester.channel])

  const app = requester.channel === "redirect" ? (redirect?.ok ? redirect.app : undefined) : appForOrigin(registry, requester.origin)
  const view: RequesterView = {
    channel: requester.channel,
    label: requester.channel === "redirect" ? destinationLabel(request.redirectUrl) : requester.origin,
    appName: app?.name,
    embeddedIn: requester.embeddedIn,
    openedFrom: requester.openedFrom,
    evidence: requester.evidence,
  }
  const label = decision.outcome === "show" ? decision.requesterLabel : view.label ?? "this site"
  const busy = phase === "busy"

  let body: ReactNode
  if (phase === "done") {
    body = (
      <div className="flex flex-col items-center gap-2 py-10 text-center" data-testid="done">
        <CheckCircle2 className="w-8 h-8 text-green-500" />
        <p className="text-sm text-foreground">Done. You can close this window.</p>
      </div>
    )
  } else if (phase === "undelivered") {
    body = (
      <div className="flex flex-col items-center gap-2 py-10 text-center" data-testid="undelivered">
        <p className="text-sm text-foreground">The result could not be returned to {label}.</p>
        <p className="text-xs text-muted-foreground">Close this window and try again from the app.</p>
      </div>
    )
  } else if (phase === "closed") {
    body = (
      <div className="py-10 text-center text-xs text-muted-foreground" data-testid="closed">
        Close this window to return to the app.
      </div>
    )
  } else if (decision.outcome === "refuse") {
    body =
      decision.reason === "requester-unknown" && !settled ? (
        <div className="flex flex-col items-center gap-2 py-10" data-testid="waiting">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
          <p className="text-xs text-muted-foreground">Checking which site opened this…</p>
        </div>
      ) : (
        <Refusal reason={decision.reason} onClose={() => closeRefusal(decision.reason)} />
      )
  } else if (subject?.kind === "sign-in" || (request.action === "connect" && subject?.kind === "ownership")) {
    body = (
      <WalletConnection
        proof={subject.kind === "ownership" ? subject.challenge : null}
        requesterLabel={label}
        framed={framed}
        onConnected={connected}
        onCancel={cancel}
      />
    )
  } else if (subject?.kind === "message") {
    body = <MessageReview kind="message" text={subject.text} requesterLabel={label} framed={framed} busy={busy} error={error} onApprove={approve} onCancel={cancel} />
  } else if (subject?.kind === "message-without-text") {
    body = <MessageReview kind="message-without-text" fingerprint={subject.fingerprint} requesterLabel={label} framed={framed} busy={busy} error={error} onApprove={approve} onCancel={cancel} />
  } else if (subject?.kind === "ownership") {
    body = <ApprovalReview kind="ownership" requesterLabel={label} framed={framed} busy={busy} error={error} onApprove={approve} onCancel={cancel} />
  } else if (subject?.kind === "approval") {
    body = <ApprovalReview kind="approval" fingerprint={toHex(subject.challenge)} requesterLabel={label} framed={framed} busy={busy} error={error} onApprove={approve} onCancel={cancel} />
  } else if (subject?.kind === "transaction") {
    body = (
      <TransactionReview
        preview={subject.preview}
        requestedCluster={parseCluster(request.clusterSimulation)}
        requesterLabel={label}
        framed={framed}
        busy={busy}
        error={error}
        onApprove={approve}
        onCancel={cancel}
        onNetwork={setNetwork}
      />
    )
  }

  return (
    <div className="h-full w-full bg-background text-foreground font-sans antialiased overflow-auto">
      <main className="mx-auto flex w-full max-w-md flex-col gap-3 p-3">
        <RequesterBar view={view} />
        {body}
      </main>
    </div>
  )
}
