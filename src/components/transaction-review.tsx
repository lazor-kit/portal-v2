import { Info, Loader2 } from "lucide-react"
import { useEffect, useState } from "react"
import { Buffer } from "buffer"
import { ApproveButtons } from "@/components/approve-buttons"
import { connectionFor, simulateTransaction, type SimulationResult } from "@/utils/simulation"
import { previewBlockhash, resolveCluster, type Cluster, type ResolvedCluster } from "@/utils/cluster"

interface TransactionReviewProps {
  /** The transaction preview the request carried (base64). */
  preview: string
  /** The cluster the request named, if any. */
  requestedCluster: Cluster | null
  requesterLabel: string
  framed: boolean
  busy: boolean
  error: string | null
  onApprove: () => void
  onCancel: () => void
  /** The network the preview was simulated on, once known. */
  onNetwork?: (network: ResolvedCluster) => void
  /** Ask for an explicit confirmation before Approve (a frame whose visibility can't be checked). */
  confirmRequired?: boolean
}

export function TransactionReview({ preview, requestedCluster, requesterLabel, framed, busy, error, onApprove, onCancel, onNetwork, confirmRequired = false }: TransactionReviewProps) {
  const [loading, setLoading] = useState(true)
  const [confirmed, setConfirmed] = useState(false)
  const [simulation, setSimulation] = useState<SimulationResult | null>(null)
  const [network, setNetwork] = useState<ResolvedCluster | null>(null)

  useEffect(() => {
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
        if (!cancelled) {
          setSimulation({
            appName: "Application",
            balanceChanges: [],
            network: "Unknown",
            networkFee: "Unknown",
            networkFeeUSD: "Unknown",
            autoConfirm: "Off",
            chainId: "unknown",
            error: `This transaction could not be simulated: ${(e as Error).message}`,
            unavailable: true,
          })
        }
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

  // A failed simulation is a likely failure only on a network that is known;
  // on a guessed one it says nothing about the transaction.
  const simulationFailed = !!simulation?.error && !simulation.unavailable
  const failed = simulationFailed && network?.known === true
  const unconfirmed = simulationFailed && !failed
  const changes = simulation?.balanceChanges ?? []
  // First and last when there are more than two.
  const displayChanges = changes.length > 2 ? [changes[0], changes[changes.length - 1]] : changes

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="transaction-review">
      <div className="min-h-[7.5rem] flex-1 space-y-3 overflow-y-auto" data-testid="review-content">
        <h1 className="text-base font-bold text-foreground">Review transaction</h1>

        <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-2.5 flex items-start gap-2">
          <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-blue-300/90 leading-tight" data-testid="preview-source">
            Preview supplied by {requesterLabel}. Amounts are estimates; approve only if you trust this site.
          </p>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary mb-2" />
            <p className="text-xs text-muted-foreground">Simulating transaction…</p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground pl-1">What will happen</p>

            {simulation?.error && (
              <div
                role="alert"
                data-testid={failed ? "simulation-failed" : unconfirmed ? "simulation-unconfirmed" : "simulation-unavailable"}
                className={`${failed ? "bg-red-500/10 border-red-500/30 text-red-500" : "bg-yellow-500/10 border-yellow-500/30 text-yellow-500"} border rounded-xl p-3 flex flex-col items-center justify-center text-center gap-1`}
              >
                <Info className="w-4 h-4" />
                {unconfirmed ? (
                  <>
                    <p className="text-xs font-medium">This preview could not be checked: the network this transaction is for could not be confirmed.</p>
                    <p className="text-[10px] opacity-80">{simulation.error}</p>
                  </>
                ) : (
                  <p className="text-xs font-medium">{simulation.error}</p>
                )}
                {failed && <p className="text-[10px] opacity-80">This transaction is likely to fail. Approve only if you know why.</p>}
              </div>
            )}

            {simulation && !simulation.error && (
              <div className="bg-muted/40 border border-border/60 rounded-xl overflow-hidden">
                {displayChanges.length === 0 && <div className="p-3 text-center text-xs text-muted-foreground">No balance changes detected.</div>}
                {displayChanges.map((change, index) => {
                  const isAction = change.token.startsWith("Sent to")
                  return (
                    <div key={index} className={`flex items-center justify-between p-3 ${index !== displayChanges.length - 1 ? "border-b border-border/40" : ""}`}>
                      <span className={`text-xs ${isAction ? "font-medium text-foreground" : "text-muted-foreground"}`}>{change.token}</span>
                      <span className={`text-sm font-semibold ${change.color} tracking-tight`}>{change.amount}</span>
                    </div>
                  )
                })}
                {changes.length > 2 && (
                  <div className="p-1.5 text-center bg-muted/20 border-t border-border/40">
                    <p className="text-[10px] text-muted-foreground italic">+ {changes.length - 2} intermediate changes hidden</p>
                  </div>
                )}
              </div>
            )}

            {simulation && (
              <div className="bg-muted/20 border border-border/40 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Network</span>
                  <div className="flex items-center gap-1.5" data-testid="network" data-cluster={network?.cluster} data-verified={network?.verified ? "true" : "false"} data-known={network?.known ? "true" : "false"}>
                    {network && !network.verified && <span className="text-[10px] font-medium text-yellow-500">Unverified</span>}
                    <div className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border ${network?.verified ? "bg-green-500/10 border-green-500/20" : "bg-yellow-500/10 border-yellow-500/20"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${network?.verified ? "bg-green-500" : "bg-yellow-500"}`}></span>
                      <span className={`text-[10px] font-medium ${network?.verified ? "text-green-600" : "text-yellow-500"}`}>
                        {network ? (network.cluster === "mainnet" ? "Solana Mainnet" : "Solana Devnet") : simulation.network}
                      </span>
                    </div>
                  </div>
                </div>
                {network?.mismatch && (
                  <p className="text-[10px] text-yellow-500 leading-tight">
                    The app asked for {network.cluster === "mainnet" ? "devnet" : "mainnet"}, but this transaction is for {network.cluster}.
                  </p>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Network Fee</span>
                  <div className="text-right flex flex-col items-end">
                    <span className="text-xs font-medium text-foreground">{simulation.networkFee}</span>
                    <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded text-center min-w-[40px]">{simulation.networkFeeUSD}</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {confirmRequired && !loading && (
          <label className="flex items-start gap-2 text-xs text-foreground">
            <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} data-testid="confirm" />
            I started this transaction on {requesterLabel}.
          </label>
        )}

        {error && <p className="text-xs text-red-500" role="alert">{error}</p>}
      </div>

      <ApproveButtons
        framed={framed}
        busy={busy}
        disabled={loading || (confirmRequired && !confirmed)}
        discourage={failed}
        approveLabel={failed ? "Approve anyway" : "Approve"}
        onApprove={onApprove}
        onCancel={onCancel}
      />
    </div>
  )
}
