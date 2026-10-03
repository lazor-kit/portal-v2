import { useState, type FormEvent, type MouseEvent } from "react"
import { Wallet, ArrowRight, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ceremonyErrorText, createPasskey, signIn } from "@/utils/webauthn"
import { rememberCredential, storedCredential } from "@/utils/storage"
import { useActivationGuard } from "@/security/gesture"
import { signInResult, type ConnectedResult } from "@/security/reply"
import { NotVisibleNotice } from "@/components/approve-buttons"

interface WalletConnectionProps {
  /** The ownership-proof challenge to sign while signing in, when the request carried one. */
  proof: Uint8Array | null
  requesterLabel: string
  framed: boolean
  onConnected: (result: ConnectedResult) => void
  onCancel: () => void
}

/** Longest name kept for a new passkey; authenticators may truncate past 64 bytes. */
const MAX_NAME = 60

export function WalletConnection({ proof, requesterLabel, framed, onConnected, onCancel }: WalletConnectionProps) {
  const [accountName, setAccountName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const guard = useActivationGuard({ framed, active: !busy })
  const ready = guard.state === "ready" && !busy

  const handleSignIn = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!ready || !guard.canActivate(event.nativeEvent)) return
    setBusy(true)
    setError(null)
    try {
      const { credentialId, assertion } = await signIn(proof)
      // `asserted` only with the assertion over the proof; a key only when
      // it was stored for this very passkey.
      onConnected(signInResult({ credentialId, assertion, stored: storedCredential(credentialId), timestamp: Date.now() }))
    } catch (e) {
      setError(ceremonyErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    if (!ready || !guard.canActivate(event.nativeEvent) || !submitter) return
    const name = accountName.trim().slice(0, MAX_NAME)
    if (!name) return
    setBusy(true)
    setError(null)
    try {
      const { credentialId, publicKey } = await createPasskey(name)
      rememberCredential(credentialId, { publicKey, name, createdAt: Date.now() })
      onConnected({ type: "connected", credentialId, kind: "created", publicKey, accountName: name, timestamp: Date.now() })
    } catch (e) {
      setError(ceremonyErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-[7.5rem] flex-1 flex-col items-center w-full space-y-6 overflow-y-auto py-2" data-testid="connect">
      <div className="w-full space-y-1 text-center">
        <h1 className="text-base font-bold text-foreground">Connect with passkey</h1>
        <p className="text-xs text-muted-foreground">
          {requesterLabel} asks to connect to your wallet.
          {proof && (
            <span className="inline-flex items-center gap-1 ml-1">
              <KeyRound className="w-3 h-3" /> Signing in also confirms you hold the passkey.
            </span>
          )}
        </p>
      </div>

      <div className="w-full space-y-5">
        <Button
          onClick={handleSignIn}
          disabled={!ready}
          size="lg"
          className="w-full h-12 text-base font-medium shadow-md rounded-xl"
          data-testid="sign-in"
          data-guard={guard.state}
        >
          <Wallet className="w-5 h-5 mr-2" />
          {busy ? "Waiting for passkey…" : "Sign in with passkey"}
          {!busy && <ArrowRight className="w-4 h-4 ml-2 opacity-70" />}
        </Button>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border/60" />
          </div>
          <div className="relative flex justify-center text-[11px] uppercase tracking-wider">
            <span className="bg-background px-3 text-muted-foreground/80 font-medium">New here? Create a passkey</span>
          </div>
        </div>

        <form onSubmit={handleCreate} className="space-y-3">
          <Input
            type="text"
            placeholder="Name for this passkey"
            value={accountName}
            maxLength={MAX_NAME}
            onChange={(e) => setAccountName(e.target.value)}
            className="h-11 rounded-xl border-input/80 bg-muted/30 text-sm"
            disabled={busy}
            data-testid="account-name"
          />
          <Button type="submit" variant="outline" className="w-full h-11 font-medium rounded-xl" disabled={!ready || !accountName.trim()} data-testid="create" data-guard={guard.state}>
            Create new account
          </Button>
        </form>
      </div>

      {guard.state === "not-visible" && !busy && <NotVisibleNotice />}
      {error && <p className="text-xs text-red-500 text-center" role="alert" data-testid="connect-error">{error}</p>}

      <button type="button" onClick={onCancel} className="text-xs text-muted-foreground underline-offset-4 hover:underline" data-testid="cancel">
        Cancel
      </button>
    </div>
  )
}
