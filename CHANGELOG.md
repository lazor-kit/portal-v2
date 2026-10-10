# Changelog

## Unreleased

### For integrators

- Typed requests (v1): CreateSession, RevokeSession and RemoveAuthority sent
  with `#/?lk1=<request>` after the usual query are shown as what they do
  ("0.02 SOL + 5 USDC", "No total limit on SOL", "Stop this spending
  permission", "Remove a device"), checked against the signed challenge and
  against the chain, and signed with the slot and counter the portal picks
  when the person approves. The signature reply adds a `typed` block
  (`typed*` parameters on the redirect channel) with that slot and counter.
  Requests without a fragment are handled as before. The request's JSON must
  be in its canonical form (the shared encoder's output).
  On devnet, typed CreateSession is accepted from the program upgrade at
  slot 509609649 (the binary with Unix-time session expiry); on a cluster
  whose binary lacks it, the request is refused (`wrong-network`).

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
  Firefox cannot report that; there, transactions and changes LazorKit can't
  show also ask for an explicit confirmation.
- The portal answers an optional `lazorkit:hello` handshake with
  `lazorkit:hello-ack`.
- New approval screens: each leads with one short line saying what is asked
  ("Sign in to Acme", "Sign a message", "Send 0.25 SOL"), then at most one
  caution or danger, one sentence and two facts, with everything else in
  Details. Buttons say what happens ("Approve with passkey", "Sign with
  passkey", "Continue with passkey"); Cancel is a labelled button, and Escape
  cancels (with the address sheet open, it closes the sheet). One caption line names the passkey the device will ask for; the
  first approval in a browser, and a retry, explain that the device may say
  "Sign in".
- The header names the requester from its origin and the registry only:
  "Verified site" with the registered name and the host, or the host and
  "Not verified". On the redirect channel, a registered web destination is
  where the answer returns ("Returns to", "Registered link"), and an app
  destination is "An app on this phone"; a redirect opened from another site
  is a caution on transactions and changes LazorKit can't show.
- Transaction previews are shown as the app's claim ("Acme says"), with the
  recipient as an identicon and its first and last four characters; the whole
  address, in groups of four with Copy, is one tap away. The amount leads
  only for a preview that is one plain transfer; anything LazorKit doesn't
  read is a caution. The network is named in Details as the app's preview's,
  and a network other than the one the app asked for is a caution.
- A 32-byte request with no preview is shown as "Approve a change LazorKit
  can't show", with Cancel recommended: a caution from a registered site (a
  frame or a popup), a danger with a confirmation step (and a 1.5 s delay after its box is ticked)
  from any other requester. A message that isn't text is shown with a
  caution, and its fingerprint in Details.
- Refusals say what happened in plain words, and that the passkey signed
  nothing; the reason code stays in Details. The `error` an app receives is
  unchanged.
- `registry.json` takes `feePayers`, fee payer keys an app alone uses; a
  transaction paid by one shows "Fee: Paid by <name>".
- A new passkey is named "LazorKit · <date>" unless renamed in Details.
- After answering, a popup or a redirect shows "Back to <app>". A popup
  stays open 300 ms after posting its answer, so the SDK reads the answer
  before it sees the popup close.

### For operators

- `config/portal-policy.json` and `config/registry.json` decide what is
  accepted; `vercel.json` headers (`frame-ancestors` and the page's content
  policy, report-only until `contentPolicy` is `enforce`) are generated from
  them and `index.html` with `pnpm headers`.
- The page loads nothing from another origin: its fonts (Atkinson
  Hyperlegible Next and Mono) are bundled and served from the portal itself.
- Transaction previews read the chain through `/api/rpc`, configured with
  `RPC_MAINNET_URL` and `RPC_DEVNET_URL` (both required on production and
  preview deployments). `/api/rpc` and `/api/telemetry` answer the portal's
  own pages on any domain it is served from, plus `PORTAL_ORIGIN`. The client
  bundle holds no RPC URL or key.
- `/api/rpc` also serves read-only chain reads for display: account, balance
  and token accounts, the LazorKit v2 program's Authority, Session and
  DeferredExec accounts of one wallet, and transaction history. Each method's
  parameters are checked, each client address has a request budget, and
  finalized transactions are kept in memory (an answer from memory costs no
  budget). Signature lists are the newest only, without paging. The RPC
  upstreams must serve `getProgramAccounts` and transaction history.
- The preview is simulated on the network its blockhash belongs to; a failed
  simulation on a known network shows "This will probably fail" and makes
  "Approve anyway" the secondary button. When the network cannot be confirmed, a
  failed simulation is shown as a preview that could not be checked.
- `/api/telemetry` logs decision events, naming the requesting origin or app
  scheme (refused redirect destinations included) and whether the page could
  check its visibility; register apps from these. `/api/csp-report` counts
  framings and content-policy reports; browsers do not name the framing site.
- Builds are pinned to Node 24 and pnpm 10.26; CI runs type checks, tests,
  the released-SDK compatibility tests, the header check, the build, and
  secret scans of the tree and the bundle.
