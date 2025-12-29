"use client"

import { useState, useEffect } from "react"
import { Wallet, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { signin, signup } from "../utils/webauthn"
import { getStoredCredentials } from "../utils/storage"

import { PortalCommunicator, PortalParams } from "../utils/portal-communicator"

interface WalletConnectionProps {
  onConnect: (address: string) => void
  portalParams: PortalParams | null
}

type VerificationStatus = "loading" | "verified" | "unverified" | "unknown"

export function WalletConnection({ onConnect, portalParams }: WalletConnectionProps) {
  const [accountName, setAccountName] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [, setStatus] = useState<VerificationStatus>("unknown")

  // Mock API verification function
  const verifyDomain = async (domain: string): Promise<boolean> => {
    // TODO: Replace with actual API call
    console.log("Verifying domain:", domain)
    // Simulating delay
    await new Promise(resolve => setTimeout(resolve, 500))

    // Mock whitelist
    const whitelist = ["https://localhost:3001", "https://example.com", "https://app.uniswap.org"]
    return whitelist.includes(domain) || domain.includes("localhost")
  }

  useEffect(() => {
    const handleMessage = async () => {
      // In a real scenario, you might want to filter events more strictly
      setStatus("loading")
    }

    window.addEventListener("message", handleMessage)

    return () => {
      window.removeEventListener("message", handleMessage)
    }
  }, [])

  // Function to handle sign in option
  const handleSignIn = async () => {
    try {
      setIsLoading(true)
      // Assuming setStatus is for a different state, e.g., a message display
      // setStatus({ message: 'Signing in with passkey...', type: 'info' })

      const result = await signin((msg) => console.log(msg)) // Changed to console.log as setStatus is not defined for this purpose

      // Ensure we persist the credential ID locally
      // Also, if we don't have an ACCOUNT_NAME, we might want to set a default or leave it ??
      // For now, let's keep existing or default to "Account 1"
      // saveCredentialId(result.credentialId) // saveCredentialId is not defined

      // signIn function already saves credential, just refresh UI
      const updatedCreds = getStoredCredentials()
      const storedAccountName = updatedCreds[0]?.accountName || "Account 1"

      if (portalParams) {
        // Find the matching credential to get the public key
        const matchingCred = updatedCreds.find(c => c.credentialId === result.credentialId) || updatedCreds[0];

        PortalCommunicator.reply({
          type: "WALLET_CONNECTED",
          credentialId: result.credentialId,
          publickey: matchingCred?.publicKey, // Include stored public key
          accountName: storedAccountName,
          timestamp: new Date().toISOString(),
          environment: portalParams.expoParam ? 'expo' : 'browser',
          platform: portalParams.expoParam ? 'mobile' : 'web',
          expo: portalParams.expoParam
        }, portalParams)
      }
      onConnect(result.credentialId) // Added back onConnect call
    } catch (error: any) {
      console.error(error)
      // setStatus({ message: error.message || 'Failed to sign in', type: 'error' }) // setStatus is not defined for this purpose
      if (portalParams) {
        PortalCommunicator.reply({
          type: "error",
          error: error.message || "Sign in failed"
        }, portalParams)
      }
    } finally {
      setIsLoading(false)
    }
  }

  // Function to handle sign up option
  const handleSignUp = async () => {
    try {
      setIsLoading(true)
      // setStatus({ message: 'Creating account...', type: 'info' }) // setStatus is not defined for this purpose

      const nameToUse = accountName || "Account 1"
      const result = await signup(nameToUse, (msg) => console.log(msg)) // Changed to console.log as setStatus is not defined for this purpose

      // Save with Account Name
      // saveCredential(result.credentialId, result.publickey, nameToUse) // saveCredential is not defined

      if (portalParams) {
        PortalCommunicator.reply({
          type: "WALLET_CONNECTED",
          credentialId: result.credentialId,
          publickey: result.publickey, // Returns both credentialId + publickey
          accountName: nameToUse, // Return the created account name
          timestamp: new Date().toISOString(),
          environment: portalParams.expoParam ? 'expo' : 'browser',
          platform: portalParams.expoParam ? 'mobile' : 'web',
          expo: portalParams.expoParam
        }, portalParams)
      }
      onConnect(result.credentialId) // Added back onConnect call
    } catch (error: any) {
      console.error(error)
      // setStatus({ message: error.message || 'Failed to create account', type: 'error' }) // setStatus is not defined for this purpose
      if (portalParams) {
        PortalCommunicator.reply({
          type: "error",
          error: error.message || "Sign up failed"
        }, portalParams)
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center w-full h-full p-6 space-y-8 animate-in fade-in zoom-in-95 duration-300">
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border/60" />
        </div>
        <div className="relative flex justify-center text-[11px] uppercase tracking-wider">
          <span className="bg-background px-3 text-muted-foreground/80 font-medium">
            Already have an account? Sign in with Passkey
          </span>
        </div>
      </div>

      <div className="w-full space-y-6">
        <div className="space-y-3">
          <Button
            onClick={handleSignIn}
            disabled={isLoading}
            size="lg"
            className="w-full h-12 text-base font-medium shadow-md transition-all hover:scale-[1.02] active:scale-[0.98] rounded-xl"
          >
            <Wallet className="w-5 h-5 mr-2" />
            {isLoading ? "Connecting..." : "Sign in"}
            {!isLoading && <ArrowRight className="w-4 h-4 ml-2 opacity-70" />}
          </Button>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border/60" />
          </div>
          <div className="relative flex justify-center text-[11px] uppercase tracking-wider">
            <span className="bg-background px-3 text-muted-foreground/80 font-medium">
              New to Solana? Create an account
            </span>
          </div>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); handleSignUp(); }} className="space-y-3">
          <div className="space-y-1">
            <Input
              type="text"
              placeholder="Enter your account name"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              className="h-11 rounded-xl border-input/80 bg-muted/30 focus:bg-background focus-visible:ring-offset-0 focus-visible:ring-2 focus-visible:ring-primary/20 text-sm transition-all"
              disabled={isLoading}
            />
          </div>
          <Button
            variant="outline"
            className="w-full h-11 font-medium rounded-xl border-primary/20 hover:bg-primary/5 hover:text-primary transition-all active:scale-[0.98] text-foreground/90"
            disabled={!accountName || isLoading}
          >
            Create new account
          </Button>
        </form>
      </div>
    </div>
  )
}

