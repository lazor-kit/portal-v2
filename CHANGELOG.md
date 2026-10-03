# Changelog

## Unreleased

### For integrators

- The portal signs only recognised challenge formats: LazorKit signed
  messages (shown as their text, which must match the challenge),
  ownership proofs, and 32-byte program challenges (with or without a
  transaction preview). Other requests are refused, and the app receives an
  `error` with a `code` saying why.
- Messages from `@lazorkit/wallet` 3.3.1+ and `@lazorkit/wallet-mobile-adapter`
  2.3.1+ are shown as text. Earlier versions (web 2.x and 3.0.0 to 3.3.0,
  mobile 1.5.x and 2.0.0 to 2.3.0) send message bytes as the challenge;
  those requests are refused, so upgrade to sign messages.
- Connect signs the SDK's ownership-proof `challenge` during sign-in and
  returns the assertion with `kind: 'asserted'`; a new passkey returns
  `kind: 'created'` and its public key. A sign-in with no proof to sign
  (none sent, or 32 random bytes from web 3.0.0 to 3.3.0) returns no
  `kind`. A public key is reported on sign-in only when the portal stored it
  for that exact credential.
- Replies are posted only to the origin that opened or embeds the portal, as
  the browser reports it. A page that opens the portal in a popup must let
  the browser send at least its origin to another site: no
  `Referrer-Policy: no-referrer` or `same-origin` (header or
  `<meta name="referrer">`) and no `rel="noreferrer"`. Pages should use
  `Cross-Origin-Opener-Policy: same-origin-allow-popups` if they set COOP.
- Redirect results go only to registered destinations, or to destinations
  the current policy allows. Schemes that hand a URL to a browser app
  (`x-safari-https:`, `googlechromes:`, `firefox:` and similar) are never
  destinations, and the answer to a refused request is sent back only to a
  registered destination. Register your origins and redirect URLs.
- Every screen shows the requesting origin (or, on the redirect channel, the
  app destination with its host and path) and whether it is registered.
- Approve and sign-in need a real click, and are enabled 600 ms after they
  become available; the delay starts again when the button is enabled, the
  page becomes visible or gains focus, or the mouse enters the frame. In a
  frame on Chromium-based browsers, they act only while the requester, the
  request and the buttons are all fully on screen and uncovered. Safari and
  Firefox cannot report that; there, transactions also ask for an explicit
  confirmation.
- The portal answers an optional `lazorkit:hello` handshake with
  `lazorkit:hello-ack`.

### For operators

- `config/portal-policy.json` and `config/registry.json` decide what is
  accepted; `vercel.json` headers (`frame-ancestors` and the page's content
  policy, report-only until `contentPolicy` is `enforce`) are generated from
  them and `index.html` with `pnpm headers`.
- The page loads nothing from another origin: system fonts replace the
  hosted web font.
- Transaction previews read the chain through `/api/rpc`, configured with
  `RPC_MAINNET_URL` and `RPC_DEVNET_URL` (both required on production and
  preview deployments). `/api/rpc` and `/api/telemetry` answer the portal's
  own pages on any domain it is served from, plus `PORTAL_ORIGIN`. The client
  bundle holds no RPC URL or key.
- The preview is simulated on the network its blockhash belongs to; a failed
  simulation on a known network shows a red banner and makes "Approve
  anyway" the secondary button. When the network cannot be confirmed, a
  failed simulation is shown as a preview that could not be checked.
- `/api/telemetry` logs decision events, naming the requesting origin or app
  scheme (refused redirect destinations included) and whether the page could
  check its visibility; register apps from these. `/api/csp-report` counts
  framings and content-policy reports; browsers do not name the framing site.
- Builds are pinned to Node 24 and pnpm 10.26; CI runs type checks, tests,
  the released-SDK compatibility tests, the header check, the build, and
  secret scans of the tree and the bundle.
