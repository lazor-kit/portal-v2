import { Info, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useState, useEffect } from "react"
import { simulateTransaction, SimulationResult } from "@/utils/simulation"
import { PortalCommunicator, PortalParams } from "@/utils/portal-communicator"
import { signMessage } from "@/utils/webauthn"

interface TransactionReviewProps {
  onBack: () => void
  transactionData?: string // Base64 encoded transaction
  origin?: string
  accountName?: string
  portalParams?: PortalParams | null
}

export function TransactionReview({ onBack, transactionData, origin = "Unknown App", accountName = "Account 1", portalParams }: TransactionReviewProps) {
  const [loading, setLoading] = useState(false)
  const [isSigning, setIsSigning] = useState(false)
  const [simulation, setSimulation] = useState<SimulationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadSimulation = async () => {
      console.log(transactionData)
      // If no data is provided, use a default dummy string to trigger the mock
      // If no data is provided, use a default dummy string to trigger the mock
      const txData = transactionData || "AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAIBAQVe+l8gwL9mYKXPGt7BhrNDo+e6Kgmq9isJ4mxR1i0VhutGBraNNpL7dwMmlnQ+QwGIAegmtj+6XBrWt+bK22TymouJT/dEn1YT7x6y1kaHE6T7iHNZt21x0BI+rV69jtEo/vwN3rsYqMbpDdLkPsp5PizbLAS07XOCsW5vtjlGbQbd9uHXZaGT2cvhRs7reawctIXtX1s3kTqM9YV+/wCpZ78YJUnjZJdcuM60j0xjKVSRZBgzfzZcH1XmiQAZoHkBBAMCAwEJA+gDAAAAAAAAAA=="
      setLoading(true)
      try {
        const result = await simulateTransaction(txData)
        setSimulation(result)
      } catch (error) {
        console.error("Simulation failed", error)
        setError("Failed to simulate transaction")
      } finally {
        setLoading(false)
      }
    }

    loadSimulation()
  }, [transactionData])

  const handleApprove = async () => {
    if (!portalParams?.credentialId) {
      setError("Missing credential ID for signing")
      return
    }
    if (!transactionData) {
      setError("No transaction data to sign")
      return
    }

    setIsSigning(true)
    setError(null)

    try {
      // Sign the transaction message (base64)
      // Note: webauthn.signMessage usually expects a message string. 
      // If it's a transaction, passing the base64 string is typical for this flow.
      const signatureData = await signMessage(
        portalParams.message,
        portalParams.credentialId,
        (msg) => console.log(msg)
      )
      console.log(signatureData)
      const responseData = {
        data: signatureData, // Contains normalized signature, r, s, v etc
        credentialId: portalParams.credentialId,
        originalMessage: transactionData,
        timestamp: new Date().toISOString(),
        type: 'SIGNATURE_CREATED' as const
      }

      // Reply to origin
      if (portalParams) {
        await PortalCommunicator.reply(responseData, portalParams)
      }

    } catch (err: any) {
      console.error("Signing failed", err)
      setError(err.message || "Failed to sign transaction")

      if (portalParams) {
        PortalCommunicator.reply({
          type: "error",
          error: "Signing failed",
          details: err.message
        }, portalParams)
      }
    } finally {
      setIsSigning(false)
    }
  }

  const handleReject = () => {
    // Notify origin of rejection
    if (portalParams) {
      PortalCommunicator.reply({
        type: "error",
        error: "User rejected transaction"
      }, portalParams)
    }
    onBack() // Or close/redirect?
  }


  if (loading) {
    return (
      <div className="w-full max-w-md flex flex-col items-center justify-center min-h-[300px]">
        <Loader2 className="w-8 h-8 animate-spin text-primary mb-2" />
        <p className="text-sm text-muted-foreground">Simulating transaction...</p>
      </div>
    )
  }

  // Fallback if simulation failed or hasn't loaded
  if (!simulation && !error) return null;

  return (
    <div className="w-full h-full p-4 flex flex-col">
      <div className="space-y-4 flex-1">

        {/* Header: Origin & Account */}
        <div className="flex items-center justify-between pb-4 border-b border-border/40">
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wide">Requested by</span>
            <div className="flex items-center gap-1.5">
              <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">
                {origin.charAt(0).toUpperCase()}
              </div>
              <span className="text-sm font-semibold text-foreground">{origin}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 bg-muted/40 px-3 py-1.5 rounded-full border border-border/40">
            <div className="w-5 h-5 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-[10px] text-white font-bold">
              {accountName.charAt(0).toUpperCase()}
            </div>
            <span className="text-xs font-medium text-foreground">{accountName}</span>
          </div>
        </div>

        <div className="space-y-1 text-center pt-2">
          <h1 className="text-2xl font-bold text-foreground">Review & Approve</h1>
          {/* Removed appName from here as it's now in header */}
        </div>

        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 flex items-start gap-2">
          <Info className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-300/90">
            These amounts are estimated and may change slightly. Always double-check before confirming.
          </p>
        </div>

        <div className="space-y-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground pl-1">What will happen</p>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 flex flex-col items-center justify-center text-center gap-2">
              <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-red-500">
                <Info className="w-5 h-5" />
              </div>
              <p className="text-sm font-medium text-red-500">{error}</p>
            </div>
          )}

          {simulation?.error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 flex flex-col items-center justify-center text-center gap-2">
              <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center text-red-500">
                <Info className="w-5 h-5" />
              </div>
              <p className="text-sm font-medium text-red-500">{simulation.error}</p>
            </div>
          )}

          {simulation && !simulation.error && (
            <div className="space-y-3">
              <div className="bg-muted/40 border border-border/60 rounded-2xl overflow-hidden">
                {simulation.balanceChanges.length === 0 && (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    No balance changes detected.
                  </div>
                )}
                {simulation.balanceChanges.map((change, index) => {
                  const isAction = change.token.startsWith("Sent to");
                  return (
                    <div
                      key={index}
                      className={`flex items-center justify-between p-4 ${index !== simulation.balanceChanges.length - 1 ? 'border-b border-border/40' : ''}`}
                    >
                      <div className="flex flex-col gap-0.5">
                        <span className={`text-sm ${isAction ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                          {change.token}
                        </span>
                      </div>
                      <div className={`text-right ${isAction ? 'flex flex-col items-end' : ''}`}>
                        <span className={`text-base font-semibold ${change.color} tracking-tight`}>
                          {change.amount}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {simulation && (
          <div className="bg-muted/20 border border-border/40 rounded-2xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Network</span>
              <div className="flex items-center gap-2 bg-green-500/10 px-2 py-1 rounded-full border border-green-500/20">
                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>
                <span className="text-xs font-medium text-green-600">{simulation.network}</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Network Fee</span>
              <div className="text-right flex flex-col items-end">
                <span className="text-sm font-medium text-foreground">{simulation.networkFee}</span>
                <span className="text-[10px] text-muted-foreground bg-muted px-1.5 rounded text-center min-w-[50px]">
                  {simulation.networkFeeUSD}
                </span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Auto-approve</span>
              <div className="flex items-center gap-1.5 text-foreground">
                <span className="text-sm font-medium">{simulation.autoConfirm}</span>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 pt-2">
          <Button
            variant="outline"
            onClick={handleReject}
            disabled={isSigning}
            className="w-full bg-muted/50 hover:bg-muted text-foreground font-semibold py-2.5 rounded-xl h-12 text-base border-border/50"
          >
            Reject
          </Button>
          <Button
            onClick={handleApprove}
            disabled={isSigning || !!error || (simulation?.error ? true : false)}
            className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold py-2.5 rounded-xl h-12 text-base"
          >
            {isSigning ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing...
              </>
            ) : "Approve"}
          </Button>
        </div>
      </div>
    </div>
  )
}
