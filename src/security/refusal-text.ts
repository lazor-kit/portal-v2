/** What the user reads, and what the app is told, for each reason a request is not shown. */
export const REFUSAL_TEXT: Record<string, { title: string; detail: string }> = {
  "missing-challenge": { title: "Nothing to sign", detail: "The request did not include anything to sign." },
  "malformed-challenge": { title: "Request not readable", detail: "The data to sign is not valid base64." },
  "unrecognised-format": {
    title: "Request not recognised",
    detail: "This portal signs only LazorKit messages, sign-in proofs and wallet approvals in their standard formats. Update the app's LazorKit SDK.",
  },
  "display-text-mismatch": { title: "Message does not match", detail: "The text shown with this request is not the text being signed." },
  "payload-not-allowed": { title: "Request not recognised", detail: "This request mixes kinds of data that are never signed together." },
  "connect-challenge-not-proof": { title: "Request not recognised", detail: "The sign-in proof in this request is not in the standard format." },
  "channel-unsupported": { title: "Can't answer this request", detail: "The portal can't return a result to where this request came from." },
  "requester-unknown": {
    title: "Can't confirm which site opened this",
    detail: "The browser did not say which site opened the portal, so no result can be sent. Close this window and try again from the app.",
  },
  "requester-conflict": {
    title: "Can't confirm which site opened this",
    detail: "The browser reported different sites for this request, so nothing will be signed.",
  },
  "redirect-refused": { title: "Unknown return address", detail: "This request would send the result to an address that isn't registered for it." },
  "kind-denied": { title: "Not available", detail: "This kind of request is not accepted from this app." },
  "requires-registered-app": { title: "App not registered", detail: "Only registered apps can request this kind of approval." },
  "credential-missing": { title: "No passkey named", detail: "The request does not say which passkey should sign it." },
  "unknown-action": { title: "Request not recognised", detail: "The portal doesn't know what this request is asking for." },
  "typed-malformed": {
    title: "Request not readable",
    detail: "The typed request in the URL fragment is not a valid v1 request, or the fragment changed after the page loaded.",
  },
  "typed-unsupported": { title: "Request not recognised", detail: "This portal does not know this typed request's version or kind." },
  "challenge-mismatch": {
    title: "Request does not match",
    detail: "The typed request does not recompute to the challenge in `message`, or names another passkey or authority.",
  },
  "wrong-network": {
    title: "Network not supported",
    detail: "The request's cluster or program is not the one this portal is configured for, or the deployed program is not the configured build.",
  },
  "request-invalid": { title: "Request would fail", detail: "The chain state says the program would refuse this request." },
  "stale-counter": {
    title: "Request out of date",
    detail: "The portal's node has not yet seen the passkey counter the request was prepared with. Prepare the request again.",
  },
  "chain-unavailable": { title: "Network unavailable", detail: "The portal could not read the chain state it checks before showing this request." },
}

export function refusalText(reason: string): { title: string; detail: string } {
  return REFUSAL_TEXT[reason] ?? { title: "Request refused", detail: "The portal can't process this request." }
}
