import { useEffect, useRef, useState } from "react"
import { GuardedButton } from "@/components/approve-buttons"
import { Actions, Body, Details, Hero, LinkButton, PasskeyCaption, PlainButton, Sentence, type Row } from "@/components/sheet"
import { PasskeyWaiting } from "@/components/status"
import type { Who } from "@/security/identity"
import { signInResult, type ConnectedResult } from "@/security/reply"
import { defaultPasskeyName, portalHost } from "@/utils/portal"
import { rememberCredential, storedCredential } from "@/utils/storage"
import { ceremonyErrorText, createPasskey, isNotAllowed, signIn } from "@/utils/webauthn"

interface WalletConnectionProps {
  /** The ownership-proof challenge to sign while signing in, when the request carried one. */
  proof: Uint8Array | null
  who: Who
  /** Where the request came from (nested frames and the like), for Details. */
  context: readonly Row[]
  framed: boolean
  onConnected: (result: ConnectedResult) => void
  onCancel: () => void
}

/** Longest name kept for a new passkey; authenticators may truncate past 64 bytes. */
const MAX_NAME = 60

/**
 * Sign in with a passkey, or create one. Sign-in shows what the app will
 * see; creating says what a passkey is. A sign-in whose prompt closes
 * without a passkey (none here, or canceled) leads to creating one.
 */
export function WalletConnection({ proof, who, context, framed, onConnected, onCancel }: WalletConnectionProps) {
  const [view, setView] = useState<"start" | "create">("start")
  const [busy, setBusy] = useState<"sign-in" | "create" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accountName, setAccountName] = useState(defaultPasskeyName)
  const abort = useRef<AbortController | null>(null)
  const name = who.name

  useEffect(() => () => abort.current?.abort(), [])

  const begin = (kind: "sign-in" | "create") => {
    abort.current?.abort()
    abort.current = new AbortController()
    setBusy(kind)
    setError(null)
    return abort.current.signal
  }

  const handleSignIn = async () => {
    const signal = begin("sign-in")
    try {
      const { credentialId, assertion } = await signIn(proof, signal)
      // `asserted` only with the assertion over the proof; a key only when
      // it was stored for this very passkey.
      onConnected(signInResult({ credentialId, assertion, stored: storedCredential(credentialId), timestamp: Date.now() }))
    } catch (e) {
      if (signal.aborted) return
      if (isNotAllowed(e)) setView("create")
      else setError(ceremonyErrorText(e))
    } finally {
      if (!signal.aborted) setBusy(null)
    }
  }

  const handleCreate = async () => {
    const label = accountName.trim().slice(0, MAX_NAME) || defaultPasskeyName()
    const signal = begin("create")
    try {
      const { credentialId, publicKey } = await createPasskey(label, signal)
      rememberCredential(credentialId, { publicKey, name: label, createdAt: Date.now() })
      onConnected({ type: "connected", credentialId, kind: "created", publicKey, accountName: label, timestamp: Date.now() })
    } catch (e) {
      if (signal.aborted) return
      setError(isNotAllowed(e) ? "The passkey step didn't finish, so no passkey was created." : ceremonyErrorText(e))
    } finally {
      if (!signal.aborted) setBusy(null)
    }
  }

  const stop = () => {
    abort.current?.abort()
    onCancel()
  }

  if (busy) {
    return (
      <PasskeyWaiting
        approving={{ hero: busy === "create" ? "Create your passkey" : `Sign in to ${name}` }}
        firstTime={false}
        signIn={busy === "sign-in"}
        onCancel={stop}
      />
    )
  }

  const errorLine = error && (
    <p className="text-[14px] leading-[20px] text-danger-text" role="alert" data-testid="connect-error">
      {error}
    </p>
  )

  if (view === "create") {
    const rows: Row[] = [
      { label: "What it is", value: "Your key to your account. No password, no recovery phrase." },
      {
        label: "Where it's saved",
        value: "Your device's password manager, such as iCloud Keychain or Google Password Manager, which can sync it to your other devices.",
      },
      { label: "Works with", value: `${name} and other apps that use LazorKit. It's saved for ${portalHost()}.` },
      { label: "If you lose it", value: "LazorKit can't recover it for you. Keep it in a password manager that syncs." },
      { label: "Used LazorKit before?", value: "Use that passkey, or you'll get a second, empty account." },
    ]
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="connect" data-view="create">
        <Body>
          <Hero>Create your passkey</Hero>
          <Sentence>Unlock it with Face ID, fingerprint or screen lock. It's free.</Sentence>
          {errorLine}
          <Details rows={rows}>
            <label className="block space-y-1 py-2">
              <span className="block text-[14px] leading-[20px] text-ink-2">Passkey name</span>
              <input
                type="text"
                value={accountName}
                maxLength={MAX_NAME}
                onChange={(e) => setAccountName(e.target.value)}
                className="h-12 w-full rounded-xl border border-field-line bg-surface px-3 text-[16px] text-ink"
                data-testid="account-name"
              />
              <span className="block text-[13px] leading-[18px] text-ink-2">Your device shows this name when it asks which passkey to use.</span>
            </label>
          </Details>
        </Body>
        <CreateActions framed={framed} onCreate={handleCreate} onOtherDevice={handleSignIn} onBack={() => setView("start")} />
      </div>
    )
  }

  const rows: Row[] = [
    // An app or a redirect destination has its own "Who's asking" in `context`.
    ...(who.verified || who.kind === "app" || who.destination
      ? []
      : [
          {
            label: "Who's asking",
            value: "LazorKit hasn't verified who runs this site. That's common for new apps. Only continue if you trust it, and check anything it asks you to approve later.",
          },
        ]),
    {
      label: "About LazorKit",
      value: `The account service ${name} uses. Your passkey is saved for ${portalHost()}, so your device shows that name, not ${name}'s.`,
    },
    { label: `${who.verified ? name : "It"} gets`, value: "Your account address. Balances and activity on Solana are public, so anyone with the address can see them." },
    { label: "Spending", value: "Always needs a separate approval from you." },
    ...(proof ? [{ label: "Also", value: `Signing in also shows ${name} that you hold this passkey.` }] : []),
    ...context,
  ]
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="connect" data-view="start">
      <Body>
        <Hero>Sign in to {name}</Hero>
        <Sentence>{who.verified ? name : "It"} will see your balance and activity. Signing in doesn't let it spend.</Sentence>
        {errorLine}
        <Details rows={rows} />
      </Body>
      <StartActions framed={framed} onSignIn={handleSignIn} onCancel={onCancel} onCreate={() => setView("create")} />
    </div>
  )
}

function StartActions({ framed, onSignIn, onCancel, onCreate }: { framed: boolean; onSignIn: () => void; onCancel: () => void; onCreate: () => void }) {
  return (
    <Actions caption={<PasskeyCaption />} link={<LinkButton onClick={onCreate} testId="to-create">New here? Create a passkey</LinkButton>}>
      <PlainButton onClick={onCancel} testId="cancel">
        Cancel
      </PlainButton>
      <GuardedButton label="Continue with passkey" onActivate={onSignIn} framed={framed} active testId="sign-in" />
    </Actions>
  )
}

function CreateActions({ framed, onCreate, onOtherDevice, onBack }: { framed: boolean; onCreate: () => void; onOtherDevice: () => void; onBack: () => void }) {
  return (
    <Actions
      caption={<PasskeyCaption />}
      link={
        // Signing in again offers the device's "another device" (QR) option.
        <div className="flex justify-center">
          <GuardedButton label="Have a passkey on another device?" onActivate={onOtherDevice} framed={framed} active tone="link" testId="other-device" />
        </div>
      }
    >
      <PlainButton onClick={onBack} testId="not-now">
        Not now
      </PlainButton>
      <GuardedButton label="Create passkey" onActivate={onCreate} framed={framed} active testId="create" />
    </Actions>
  )
}
