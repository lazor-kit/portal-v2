import { useCallback, useEffect, useRef, useState } from "react"
import type { ApprovalRequest } from "@/approval/envelope"
import { portalTransport, type Transport } from "@/chain/transport"
import { programs } from "@/config"
import { bindAtApprove, SNAPSHOT_INTERVAL_MS, snapshotVerdict, type BindResult } from "@/typed/approve"
import { readDeploySlot, readSnapshot, readTypedChain, type Snapshot, type TypedChainView } from "@/typed/reads"
import { needsHoldings } from "@/typed/screen"

export type TypedState =
  | { readonly phase: "loading" }
  | { readonly phase: "refused"; readonly code: "wrong-network" | "request-invalid" | "chain-unavailable" | "stale-counter"; readonly reason?: string }
  | { readonly phase: "ready"; readonly view: TypedChainView }

/** The binary is read once per page (DESIGN §3.1). */
const deploySlots = new Map<string, Promise<number | null>>()

/**
 * A typed request's chain state: read once when it is shown (refusing what
 * would fail), then a snapshot of the authority's counter and the cluster's
 * clock once a second while the screen is open. `bind()` picks the slot and
 * counter from the latest snapshot, synchronously, for the Approve click.
 * A refresh changes nothing shown, so it never re-arms the button; only a
 * snapshot that is too old, or a node behind the SDK's counter, turns it off.
 */
export function useTyped(
  request: ApprovalRequest | null,
  active: boolean,
  /** Approve can't be tapped now (the passkey prompt is open, or the answer went): the snapshots' verdict waits. */
  signing = false,
  transportFor: (cluster: ApprovalRequest["cluster"]) => Transport = portalTransport,
) {
  const signingNow = useRef(signing)
  signingNow.current = signing
  const [state, setState] = useState<TypedState>({ phase: "loading" })
  const [attempt, setAttempt] = useState(0)
  const snapshot = useRef<Snapshot | null>(null)
  /** Whether Approve can sign now; drives the button only when it changes. */
  const [canSign, setCanSign] = useState<BindResult["kind"] | "wait-behind">("wait")
  const behindSince = useRef<number | null>(null)
  /** When snapshots started, the last usable one arrived, and since when the passkey reads as removed. */
  const startedAt = useRef(0)
  const lastGoodAt = useRef<number | null>(null)
  const goneSince = useRef<number | null>(null)

  useEffect(() => {
    if (!request || !active) return
    let cancelled = false
    setState({ phase: "loading" })
    const transport = transportFor(request.cluster)
    const run = async () => {
      const key = `${request.cluster}:${request.programId}`
      const deploySlot = () => {
        let deploy = deploySlots.get(key)
        if (!deploy) {
          deploy = readDeploySlot(transport, request.programId).catch(() => {
            deploySlots.delete(key)
            return null
          })
          deploySlots.set(key, deploy)
        }
        return deploy
      }
      const result = await readTypedChain(transport, request, { config: programs[request.cluster], deploySlot, needsHoldings })
      if (cancelled) return
      setState(result.ok ? { phase: "ready", view: result.view } : { phase: "refused", code: result.code, reason: result.reason })
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [request, active, attempt, transportFor])

  const ready = state.phase === "ready"
  useEffect(() => {
    if (!request || !ready) return
    let cancelled = false
    const transport = transportFor(request.cluster)
    startedAt.current = performance.now()
    lastGoodAt.current = null
    goneSince.current = null
    const tick = async () => {
      try {
        const next = await readSnapshot(transport, request, () => performance.now())
        if (cancelled) return
        if (!next) {
          goneSince.current ??= performance.now()
          return
        }
        goneSince.current = null
        lastGoodAt.current = next.at
        snapshot.current = next
        if (next.counter + 1 < request.counter) {
          behindSince.current ??= performance.now()
        } else {
          behindSince.current = null
        }
      } catch {
        // A failed refresh leaves the last snapshot to age out; with none
        // usable for too long, the verdict below refuses.
      }
    }
    const evaluate = () => {
      if (signingNow.current) return
      const verdict = snapshotVerdict(
        { startedAt: startedAt.current, lastGoodAt: lastGoodAt.current, goneSince: goneSince.current, behindSince: behindSince.current },
        performance.now(),
      )
      if (verdict.kind === "refuse") {
        setState({ phase: "refused", code: verdict.code, reason: verdict.reason })
        return
      }
      const result = bindAtApprove(request, snapshot.current, performance.now())
      setCanSign(result.kind === "sign" ? "sign" : result.reason === "behind" ? "wait-behind" : "wait")
    }
    void tick().then(evaluate)
    const refresh = window.setInterval(() => void tick(), SNAPSHOT_INTERVAL_MS)
    const check = window.setInterval(evaluate, 250)
    return () => {
      cancelled = true
      window.clearInterval(refresh)
      window.clearInterval(check)
    }
  }, [request, ready, transportFor])

  /** For the Approve click: the binding from the latest snapshot, or why not yet. */
  const bind = useCallback((): BindResult => {
    if (!request) return { kind: "wait", reason: "no-snapshot" }
    return bindAtApprove(request, snapshot.current, performance.now())
  }, [request])

  const retry = useCallback(() => {
    snapshot.current = null
    behindSince.current = null
    lastGoodAt.current = null
    goneSince.current = null
    setCanSign("wait")
    setAttempt((n) => n + 1)
  }, [])

  return { state, canSign: canSign === "sign", bind, retry }
}
