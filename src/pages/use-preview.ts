import { useEffect, useMemo, useState } from "react"
import { Buffer } from "buffer"
import { connectionFor, simulateTransaction, type SimulationResult } from "@/utils/simulation"
import { previewBlockhash, resolveCluster, type Cluster, type ResolvedCluster } from "@/utils/cluster"
import { decodePreview, summarizePreview, type DecodedPreview, type PreviewSummary } from "@/utils/preview"

export interface PreviewState {
  readonly loading: boolean
  readonly simulation: SimulationResult | null
  readonly network: ResolvedCluster | null
  readonly decoded: DecodedPreview | null
  /** The payment and fees, once the simulation has read token owners and decimals. */
  readonly summary: PreviewSummary | null
}

const UNAVAILABLE = (error: Error): SimulationResult => ({
  appName: "Application",
  balanceChanges: [],
  network: "Unknown",
  networkFee: "Unknown",
  networkFeeUSD: "Unknown",
  autoConfirm: "Off",
  chainId: "unknown",
  error: `This transaction could not be simulated: ${error.message}`,
  unavailable: true,
})

/**
 * The preview of a transaction request: decoded at once, then its network
 * settled and simulated through the portal's RPC route. Kept by the page, so
 * the waiting, canceled and approved screens show the same summary.
 */
export function usePreview(preview: string | null, requestedCluster: Cluster | null, onNetwork?: (network: ResolvedCluster) => void): PreviewState {
  const [loading, setLoading] = useState(preview !== null)
  const [simulation, setSimulation] = useState<SimulationResult | null>(null)
  const [network, setNetwork] = useState<ResolvedCluster | null>(null)
  const decoded = useMemo(() => (preview ? decodePreview(preview) : null), [preview])

  useEffect(() => {
    if (!preview) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        const blockhash = previewBlockhash(new Uint8Array(Buffer.from(preview, "base64")))
        const resolved = await resolveCluster(requestedCluster, blockhash, async (cluster, hash) =>
          (await connectionFor(cluster).isBlockhashValid(hash, { commitment: "processed" })).value,
        )
        if (cancelled) return
        setNetwork(resolved)
        onNetwork?.(resolved)
        const result = await simulateTransaction(preview, resolved.cluster)
        if (!cancelled) setSimulation(result)
      } catch (e) {
        if (!cancelled) setSimulation(UNAVAILABLE(e as Error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
    // onNetwork is a reporting callback; the simulation depends on the request only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, requestedCluster])

  const summary = useMemo(
    () => (decoded && !loading ? summarizePreview(decoded, simulation?.facts ?? null) : null),
    [decoded, loading, simulation],
  )
  return { loading, simulation, network, decoded, summary }
}
