import { useState, useEffect } from "react"
import { WalletConnection } from "@/components/wallet-connection"
import { TransactionReview } from "@/components/transaction-review"
import { PortalCommunicator, PortalParams } from "@/utils/portal-communicator"

type AppScreen = "wallet" | "transaction"

export default function Home() {
    const [screen, setScreen] = useState<AppScreen>("wallet")
    const [, setConnected] = useState(false)
    const [, setWallet] = useState<string>("")
    const [transactionData, setTransactionData] = useState<string>("")
    const [portalParams, setPortalParams] = useState<PortalParams | null>(null)

    useEffect(() => {
        const params = PortalCommunicator.getParams()
        setPortalParams(params)

        console.log("Portal params:", params)

        if (params.action === 'sign' && params.message) {
            setTransactionData(params.transaction || params.message)
            setScreen("transaction")
        } else if (params.action === 'connect') {
            setScreen("wallet")
        }
    }, [])

    const handleConnect = (address: string) => {
        setWallet(address)
        setConnected(true)
        // If we were connecting to sign, maybe move to transaction?
        // But for now, standard flow: connect -> done (or wait for next instruction)
        // If there is a pending transaction in params, we could go there.
        if (portalParams?.action === 'sign' && portalParams.message) {
            setScreen("transaction")
        } else {
            // If just connect, we might want to stay or show success?
            // For this specific 'portal' flow, usually 'connect' ends the flow or waits.
            // But existing behavior was 'setScreen("transaction")'. 
            // Let's keep it 'wallet' if explicitly 'connect', or 'transaction' if explicitly 'sign'.
            // If default behavior:
            setScreen("transaction")
        }
    }

    const handleBackToDashboard = () => {
        setScreen("wallet")
    }

    return (
        <div className="h-full w-full bg-background text-foreground font-sans antialiased overflow-hidden">
            <main className="flex items-center justify-center p-0 h-full w-full">
                {screen === "wallet" && <WalletConnection onConnect={handleConnect} portalParams={portalParams} />}
                {screen === "transaction" && (
                    <TransactionReview
                        onBack={handleBackToDashboard}
                        transactionData={transactionData}
                        origin="Lazor Kit App" // We could parse origin from query or referrer if needed
                        accountName={portalParams?.accountName || "Account 1"}
                        portalParams={portalParams}
                    />
                )}
            </main>
        </div>
    )
}
