# Changelog

## Unreleased

### For integrators

- The portal signs only recognised challenge formats: LazorKit signed
  messages (shown as their text, which must match the challenge),
  ownership proofs, and 32-byte program challenges (with or without a
  transaction preview). Other requests are refused, and the app receives an
  `error` with a `code` saying why.
- Messages from `@lazorkit/wallet` 3.3.1+ and `@lazorkit/wallet-mobile-adapter`
  2.3.1+ are shown as text. Earlier versions send message bytes as the
  challenge; those requests are refused, so upgrade to sign messages.
- Connect signs the SDK's ownership-proof `challenge` during sign-in and
  returns the assertion with `kind: 'asserted'`; a new passkey returns
  `kind: 'created'` and its public key. A public key is reported on sign-in
  only when the portal stored it for that exact credential.
- Replies are posted only to the origin that opened or embeds the portal, as
  the browser reports it. Pages that open the portal should not send
  `Referrer-Policy: no-referrer`, and should use
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` if they set COOP.
- Redirect results go only to registered destinations, or to destinations
  the current policy allows. Register your origins and redirect URLs.
- Every screen shows the requesting origin (or the app's scheme on the
  redirect channel) and whether it is registered.
- Approve and sign-in need a real, visible click, and are enabled 600 ms
  after they appear.
- The portal answers an optional `lazorkit:hello` handshake with
  `lazorkit:hello-ack`.

### For operators

- `config/portal-policy.json` and `config/registry.json` decide what is
  accepted; `vercel.json` headers (`frame-ancestors`) are generated from them
  with `pnpm headers`.
- Transaction previews read the chain through `/api/rpc`, configured with
  `RPC_MAINNET_URL`, `RPC_DEVNET_URL` and `PORTAL_ORIGIN`. The client bundle
  holds no RPC URL or key.
- The preview is simulated on the network its blockhash belongs to; a failed
  simulation shows a red banner and makes "Approve anyway" the secondary
  button.
- `/api/telemetry` and `/api/csp-report` log decision events and framing
  reports as one JSON line each.
- Builds are pinned to Node 24 and pnpm 10.26; CI runs type checks, tests,
  the header check, the build, and secret scans of the tree and the bundle.
