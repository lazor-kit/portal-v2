# LazorKit passkey portal

The hosted page that `@lazorkit/wallet` (web) and `@lazorkit/wallet-mobile-adapter`
open to create a passkey, sign in with it, and sign with it. The web SDK shows
it in a dialog (an iframe) or a popup; the mobile adapter opens it in the
system browser and gets the result back through a redirect.

## How a request is handled

### What the URL carries

| Parameter | Used on | Meaning |
|---|---|---|
| `action` | all | `connect` or `sign` |
| `challenge` | connect | an ownership-proof challenge to sign while signing in (optional) |
| `message` | sign | the challenge to sign (base64 or base64url) |
| `displayMessage` | sign | the text of a signed message |
| `transaction` | sign | a transaction preview (base64) |
| `credentialId` | sign | the passkey to sign with (base64); required |
| `clusterSimulation` | sign | `mainnet` or `devnet`, for the preview |
| `redirect_url` (`redirectUrl`, `expo`) | all | where a result goes on the redirect channel |
| `rid` | all | a request id for the optional handshake |

Nothing in the URL is trusted as is: the challenge is classified, the
requester comes from the browser, and a redirect destination is checked.

A typed request (below) adds a URL fragment, `#/?lk1=<base64url(UTF-8 JSON)>`,
to the same query. The fragment never reaches a server or a `Referer`.

### What is signed

The portal signs only these challenge formats (`src/security/challenge.ts`):

| Kind | Bytes | Shown as |
|---|---|---|
| Message | 58: `"LazorKit signed message v1"` ‖ SHA-256(tag ‖ UTF-8 text) | the text, only when it recomputes to the challenge, with "Matches what your passkey signs" in Details; without text, "Sign data" with a caution and the fingerprint in Details |
| Ownership proof | 59: `"LazorKit ownership proof v1"` ‖ 32 random bytes | "One more step"; signed during sign-in on connect |
| Transaction | 32, with a preview | the simulated preview, as the requesting app's claim ("Acme says"): "Send 0.25 SOL" and the recipient when it is one plain transfer (compute-budget and memo instructions aside), otherwise "Approve this action"; anything LazorKit doesn't read is a caution |
| Approval | 32, no preview | "Approve a change LazorKit can't show", with Cancel as the recommended button: a caution from a registered site (a frame or a popup); a danger from any other requester, approved only after a confirmation step |

Anything else is refused with a reason, and the app is told why; the person
reads what happened in plain words, and that their passkey signed nothing.
The passkey always signs the classified bytes (for a typed request, the
challenge recomputed with the slot and counter picked at Approve), with the
passkey `credentialId` names. Control, zero-width and bidirectional characters in a
message are shown as labelled markers ("reversed text"), never applied, with
a caution; their code points are listed in Details.

### Typed requests

A typed request says what the program instruction does, so the portal can
show it and check that the passkey signs exactly that (`src/approval`,
`src/typed`). Version 1 covers CreateSession, RevokeSession and
RemoveAuthority:

```jsonc
{ "v": 1, "kind": "createSession",        // | "revokeSession" | "removeAuthority"
  "cluster": "devnet", "programId": "57bT…", "wallet": "…", "authority": "…",
  "credentialId": "<base64url>", "payer": "…", "counter": 7,
  "preparedSlot": "412388000", "minContextSlot": 412387990,   // optional
  "args": { "sessionKey": "…", "expiresAt": "<unix seconds>", "actions": "<base64url>" } }
// revokeSession: args { session, refund }; removeAuthority: args { target, refund }
```

- The schema is strict: exact keys, base58 addresses, decimal u64 strings,
  unpadded base64url, the actions buffer exactly as the program receives it
  (decoded with the program's own rules). The JSON text must be the
  encoder's own, byte for byte: keys in schema order, no whitespace, no
  duplicate keys, integers written as integers. At most 8,192 characters in
  the fragment and 16,384 in the URL.
- The fragment is read once, before the router starts, then removed from the
  address bar; a `hashchange` after that refuses the request.
- On load, the envelope with its own `preparedSlot` and `counter` must
  recompute to the `message` the SDK sent, `credentialId` must be the
  query's, and `authority` must be that passkey's on the wallet. Then the
  portal reads the chain (`src/typed/reads.ts`): the binary (its last-deploy
  slot against `config/programs.json`), the wallet, the authority, the Clock,
  the session or the authority to remove, the mints the limits name, and the
  vault when a "could spend all" line needs it. What the program would refuse
  is refused here.
- While the screen is open the portal reads the authority's counter and the
  Clock once a second. Approve signs with that slot and the chain's counter
  + 1 (never below the SDK's), picked inside the click: the program's
  150-slot window starts when the person approves, not when the app
  prepared. If no usable snapshot arrives for 10 seconds the request is
  refused (`chain-unavailable`, with "Try again"; `request-invalid` when the
  passkey was removed from the account meanwhile). The reply adds `typed: { v, kind, slot, counter, sysvarIxIndex }`
  (`typedV`, `typedKind`, `typedSlot`, `typedCounter`, `typedSysvarIx` on
  the redirect channel); the SDK recomputes the challenge from its own inputs
  with them before it sends anything.
- Screens: `session-create` ("Spending limit", the totals, "Fernway can spend
  this to anyone, without asking you.", when it ends and where to stop it),
  `session-no-total` (a caution block: "No total limit on SOL" and how much
  could go; also when an asset's only total is a recurring limit that, over
  the permission's life, could take all of it, or a window under an hour
  when the balance can't be read), `session-no-limits` (a danger block, Cancel solid, a
  confirmation), `session-stop`, `device-remove` and `key-remove`. Details
  opens with "Matches what your passkey signs".
- Refusals: `typed-malformed`, `typed-unsupported`, `challenge-mismatch`,
  `wrong-network`, `request-invalid`, `stale-counter`, `chain-unavailable`
  (with "Try again"). A request that carries a fragment never falls back to
  the screen for a change LazorKit can't show.

### Who gets the answer

The requesting origin comes from what the browser reports
(`src/security/requester.ts`):

- in a frame: `location.ancestorOrigins`, the origin of messages from the
  parent window, and the referrer;
- in a popup: messages from the opener, and the referrer.

Evidence that disagrees refuses the request. A page that opens the portal in
a popup (every web SDK on Safari and mobile, and web 2.x for every connect)
must let the browser send at least its origin to another site until the SDK
sends the handshake below: no `Referrer-Policy: no-referrer` or `same-origin`,
whether set as a header or with `<meta name="referrer">`, and no
`rel="noreferrer"` on what opens the portal. Otherwise the portal cannot name
the requester and refuses (`requester-unknown`). Every reply is posted with that
origin as its target (`src/security/reply.ts`), so the browser delivers it only
to a window showing the origin on screen. With no origin, nothing is sent and
the user is told to close the window. A small inline script in `index.html`
records the origin and type of messages that arrive before the app has loaded
(never their contents).

On the redirect channel the destination must be registered for an app, or
allowed by the policy while the registry fills (`src/security/redirect.ts`).
Never redirect destinations, registered or not: script, data, file and
similar schemes; schemes that hand a URL to a browser app, which would then
open it on a web host (`x-safari-https:`, `googlechromes:`, `firefox:`,
`microsoft-edge-https:`, `opera-https:`, `brave:`, Android `intent:` and
`android-app:`, any scheme ending in `-http` or `-https`, and similar); and
`mailto:`, `sms:`, `tel:`. The answer to a refused request goes back only to
the requesting origin or a registered destination: an unregistered
destination is never navigated to for a refusal.

Every screen shows who is asking, from the origin and the registry only: a
registered origin (a frame or a popup, as the browser reports it) as its
registered name, "Verified site" and the host; any other origin as its host,
"Not verified". On the redirect channel any page can open the portal, so
nothing there is a verified site: a registered web destination is shown as
the app's name, "Returns to" its host and "Registered link"; an app
destination as "An app on this phone" with where the result returns (scheme,
host and path, never just the scheme). Hosts are never shortened, and the
name registered under the public suffix (Public Suffix List, private domains
included) is set in bold. Nested frames and the page that opened a redirect
are listed in Details; on a transaction or a change LazorKit can't show, a
redirect opened from a site other than its destination's is a caution.

### The screens

Each screen leads with one short line saying what is asked, then at most one
caution or danger, one sentence and two facts; everything else is in Details,
closed until opened. The buttons stay on screen: "Cancel" (a labelled button;
Escape does the same, and closes only the address sheet while it is open) and the action ("Approve with passkey", "Sign with
passkey", "Continue with passkey", "Create passkey"). Where Cancel is
recommended (a likely failure, a change LazorKit can't show), it is the solid
button on the right. One line under the buttons names the passkey the device
will ask for ("Passkey for portal.lazor.sh"); on the first approval in a
browser, and after a passkey step that didn't finish, it says the device may
say "Sign in" and that this is the approval. While the device's prompt is
open the screen says so, with Cancel; a prompt that doesn't finish leads to
"Nothing was approved" and Try again. Once the answer has gone, a popup or a
redirect shows "Back to <app>": the popup closes, or the redirect goes to the
same destination with the same answer again. In a frame, the SDK closes the
dialog.

A transaction preview is shown as the app's claim until requests carry what
is signed: "Acme says" over the summary, "Preview from Acme. LazorKit can't
yet confirm it matches what you sign." in Details, and, from a requester
that isn't verified, a caution that LazorKit can't confirm the amount. The
amount leads only when the preview is one plain transfer, which the fee
payer doesn't send, with compute-budget or memo instructions at most;
anything else is "Approve this action", and from a verified site, an
instruction LazorKit doesn't read is a caution ("Uses a service LazorKit
can't read."). Details lists the instructions and their programs. A
recipient is shown as an identicon and its first and last four characters;
tapping it shows the whole address in groups of four, with Copy. The
network is the preview's too: Details names it as the app's ("Solana Devnet
(from Acme's preview)"), and a preview for a network other than the one the
app asked for is a caution. The fee line says "Paid by <app>" only for a fee
payer registered to that app (`feePayers`); a payment to the fee payer is
shown as a fee the user pays.

Colours: one accent (indigo) for the recommended button and the focus ring;
risk tiers that differ in lightness and carry their own icon and words; light
and dark follow the system. Text is at least 13px, and contrast is checked by
`test/screens.test.ts`.

### Approving

Approve and sign-in act only on a real click (`isTrusted`), and only 600 ms
after they become available (1.5 s after the box of a danger screen's
confirmation step is ticked; `src/security/gesture.ts`). While a button arms,
a thin bar fills inside it. The delay starts
again whenever what is under the pointer may have changed: the button is
enabled (a simulation finishes, a box is ticked), the page becomes visible
again, a popup or top-level page gains focus, or the mouse enters the frame.

The screen is laid out to the frame's height: the requester bar and the
buttons stay on screen, and the request scrolls between them. In a frame,
on browsers that report it (IntersectionObserver v2: Chromium-based browsers),
the buttons act only while the whole decision surface (requester bar, request
and buttons) is fully on screen and not covered, faded or transformed by the
embedding page. A frame too small to show the request at its minimum height
keeps the buttons off.

Safari and Firefox do not report this. There, a transaction and a change
LazorKit can't show from a registered site also need an explicit
confirmation (one from a requester that isn't registered always does), and
telemetry records `visibility: "untracked"`. Until `framing.mode` is
`enforce`, a site that is not registered can frame the portal on those
browsers without the portal being able to tell that it is covered.

### Optional handshake

An SDK may post `{ type: 'lazorkit:hello', v: 1, rid }` to the portal origin
from the window that opened or embeds it, with the same `rid` as the URL. The
portal answers `{ type: 'lazorkit:hello-ack', rid }` to the sender's origin,
and counts the sender's origin as evidence.

## Configuration

The files are checked when the app is built and loaded
(`src/security/config.ts`, `src/typed/programs.ts`); a change is a commit and a deploy.

### `config/portal-policy.json`

| Field | Values |
|---|---|
| `stage` | `transition` or `enforce`; reported with telemetry |
| `gates.messageWithoutText`, `gates.transaction`, `gates.approval` | `allow` (anyone), `registered` (registered apps), `deny` |
| `gates.webview` | answers through an in-app WebView bridge; `deny` unless needed |
| `connectNonProofChallenge` | `ignore` (sign in without it) or `refuse` |
| `redirects.unregisteredSchemes` | `allow` (shown as not registered) or `deny` |
| `redirects.unregisteredWeb` | `same-origin` (only to the page that sent the user) or `deny` |
| `redirects.deniedSchemes` | extra schemes never redirected to |
| `framing.mode` | `report` (any https page may frame; framings by others than registered are counted) or `enforce` (registered only) |
| `framing.allowLoopback` | allow `localhost` and `127.0.0.1` for local development |
| `contentPolicy` | the page's own content policy (below): `report` (report-only) or `enforce` |

The `enforce` settings are `transaction` and `approval` at `registered`,
both redirect rules at `deny`, `framing.mode` at `enforce`, and
`contentPolicy` at `enforce`.

### `config/programs.json`

```json
{ "devnet": { "programId": "57bTNWqtYTJbWuLWASKo6GqUTAK6oFDUR5c6hEc6V8nv", "lastDeploySlot": 509521792,
              "features": ["wallet-bound-challenge", "d13", "nonowner-invariants"] } }
```

The LazorKit program a typed request may name on each cluster, the slot its
binary was last deployed at, and what that binary does
(`wallet-bound-challenge`, `d13`, `nonowner-invariants`, `time-expiry`). A
claim that depends on the binary is made only when the feature is listed and
the chain's program data says the binary is that deploy. A cluster that is
not listed refuses typed requests (`wrong-network`); so does CreateSession
without `time-expiry`. On a listed binary without `time-expiry`, action
expiries and recurring windows are read as slots; on a binary that isn't
the listed deploy, no judgment that depends on an expiry is made.

The deploy slot is known only once the program upgrade lands, so a program
release goes: upgrade the program, read its ProgramData last-deploy slot,
update this file and deploy the portal, and only then publish SDKs that
send typed requests. Until the portal is redeployed, a typed CreateSession
on that cluster is refused (`wrong-network`); RevokeSession and
RemoveAuthority are not affected.

### `config/registry.json`

```json
{
  "version": 1,
  "apps": [
    {
      "id": "acme",
      "name": "Acme",
      "origins": ["https://app.acme.xyz"],
      "redirects": ["acme://", "https://app.acme.xyz/callback"],
      "programChallenges": true,
      "feePayers": ["GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"]
    }
  ]
}
```

- `origins`: exact origins, `https://` (or `http://` on loopback), no path.
- `redirects`: a scheme (`acme://`) or a URL prefix; `/callback` covers
  `/callback/done` but not `/callbackx`.
- `programChallenges: false` refuses 32-byte challenges from that app.
- `feePayers`: fee payer keys (base58) the app alone uses; a transaction paid
  by one shows "Fee: Paid by Acme". A key may belong to one app only; never
  list a shared paymaster.
- Other fields (contact, dates, notes) are ignored by the code.

### Headers

`vercel.json` is generated from both files:

```bash
pnpm headers        # write vercel.json
pnpm headers:check  # fail when it is out of date (CI)
```

It sets `Content-Security-Policy` (enforced) and
`Content-Security-Policy-Report-Only` with:

- `frame-ancestors`: who may frame the portal (`framing.mode`);
- the content policy (`contentPolicy`): scripts from the portal's origin and
  the inline message recorder in `index.html` (by its SHA-256, so the check
  fails when the script changes and `vercel.json` was not regenerated),
  styles from the portal's origin, data from the portal's origin and
  `https://api.coingecko.com` (the SOL price for the fee), images from the
  portal's origin and `data:`, and no plugins, `<base>` or form submissions.
  The page loads nothing from another origin: its fonts (Atkinson
  Hyperlegible Next and Mono) are bundled and served from the portal's own
  origin.

Reports go to `/api/csp-report`. It never sets `X-Frame-Options` or
`Cross-Origin-Opener-Policy: same-origin`; apps that open the portal in a
popup should use `same-origin-allow-popups` if they set COOP.

## Server routes (`api/`)

| Route | Purpose |
|---|---|
| `POST /api/rpc?cluster=mainnet\|devnet` | Solana JSON-RPC, read-only: the transaction preview and the chain reads pages show (below); one request of at most 64 KiB, from the portal's own pages, within a budget per client |
| `POST /api/telemetry` | one decision event, logged as a JSON line; listed fields only |
| `POST /api/csp-report` | CSP reports, logged as origins only |

`/api/rpc` and `/api/telemetry` answer pages of the origin serving them
(whatever domain the deployment is reached on, a staging domain included),
the deployment's own Vercel URLs, and `PORTAL_ORIGIN`.

### `/api/rpc`

The cluster comes from the request URL, and picks the upstream. Only these
methods are forwarded, each with its parameters checked
(`api/rpc.ts`); nothing that writes, signs or airdrops:

| Method | Accepted |
|---|---|
| `getMultipleAccounts` | 1 to 100 addresses, `base64` |
| `simulateTransaction` | a base64 transaction of at most 2048 characters, `sigVerify` off, at most 128 accounts returned |
| `getLatestBlockhash`, `isBlockhashValid` | commitment and `minContextSlot` only |
| `getAccountInfo` | one address, `base64`, optional `dataSlice` |
| `getBalance` | one address |
| `getTokenAccountsByOwner` | one owner, by mint or by program (SPL Token or Token-2022 only), `base64` or `jsonParsed` |
| `getProgramAccounts` | the LazorKit v2 program of the request's cluster only, `base64`, with exactly two filters: one account type (Authority, Session or DeferredExec) and one wallet at that type's wallet offset |
| `getSignaturesForAddress` | one address, the newest 1 to 1000 signatures (no `before` or `until`), `confirmed` or `finalized` |
| `getTransaction` | one signature, `json`, `jsonParsed` or `base64`, transaction version 0 or 1, `confirmed` or `finalized` |

- **Budget.** Each client address (an IPv6 client by its /64) has a budget
  of request cost: 300, refilled at 5 a second. A program listing costs 10,
  a signature list 5, a simulation or token listing 2, anything else 1.
  Only calls to the upstream are charged; an answer from memory is free.
  Past it, the route answers 429 with `Retry-After` and calls nothing. The
  budget lives in the memory of the instance serving the request: it slows a
  loop, it does not replace a rate limit at the edge.
- **Caching.** Every answer is `Cache-Control: no-store`. A finalized
  transaction cannot change, so the instance keeps up to 8 MiB of them and
  answers a repeat without the upstream.
- **Limits.** 8 s for the upstream to answer, 4 MiB for its answer.
- **Logs.** One line per request: method, cluster, status, duration. Never
  the upstream URL, a client address, or a request body.

Environment variables (Production and Preview):

| Name | Notes |
|---|---|
| `RPC_MAINNET_URL` | mainnet upstream, with its key; mark it sensitive; mainnet reads are unavailable without it |
| `RPC_DEVNET_URL` | devnet upstream, a keyed endpoint; required: on a Vercel production or preview deployment, devnet reads are unavailable without it (the public devnet RPC rate-limits the platform's shared addresses). Locally it defaults to `https://api.devnet.solana.com` |
| `PORTAL_ORIGIN` | optional further origins allowed to call `/api/rpc` and `/api/telemetry`, comma-separated |

Both upstreams must serve `getProgramAccounts` and transaction history
(`getSignaturesForAddress`, `getTransaction`, version 1 transactions
included): public endpoints often refuse or throttle these.

Never put a secret in a `VITE_*` variable: those are compiled into the page.
Rate-limit `/api/rpc` and `/api/telemetry` at the edge.

### Chain reads for display (`src/chain`)

Pages read the chain only through `/api/rpc`. Each read answers
`{ status: 'ok', value }` or `{ status: 'unavailable', reason }` (`not-configured`,
`rate-limited`, `timeout`, `upstream`, `refused`, `network`, `malformed`), and never
fills in a value it could not read.

| Read | What it returns |
|---|---|
| `readVault` | the vault's SOL, and its SPL Token and Token-2022 accounts with any delegate and delegated amount |
| `readWalletAccounts` | the wallet's authorities (role, key, policy bytes), sessions (key, expiry: Unix seconds on a time-expiry binary, a slot before it; limit bytes) and deferred executions; accounts of a newer layout are counted, not decoded |
| `readPaymentHistory` | payments out of the vault: successful, non-zero SOL transfers from it and token transfers it signed out of its token accounts, by the address paid (for tokens, the owner of the receiving account). Incoming transfers, failed transactions, zero-value transfers and transfers it did not sign never count; their other parties are listed apart as `counterparties`. It lists the newest 1000 signatures and reads at most 100 successful transactions, and says how many of the newest it read without a gap (`scanned`) and whether that was all of them (`coverage`) |
| `paymentsTo` | from a history: the payments to one address, newest first |
| `checkRecipient` | from a history: the relation (`paid` with a count and the last time, `first-time`, `not-in-recent` with how many were read, `own-account`, or `unknown`), and the closest lookalike among addresses paid, the user's own and saved ones, then counterparties (`none` only when the whole history was read; `none-in-recent` otherwise) |

Addresses are compared on their full 32 bytes. A lookalike shares the ends of
a known address without being it: at least 3 leading and 3 trailing
characters is `danger`; only the first 4 or only the last 4 is `caution`.
A counterparty match (`like.kind === 'counterparty'`) is an address that
sent money in or got nothing of value: never "paid before". Counterparties
are compared only when the recipient is not itself paid, own or saved.
`first-time` needs the whole history read and every payment's recipient
named; otherwise the relation is `not-in-recent` or `unknown`.
`useRecipientCheck` (`src/hooks`) runs the check for a payment screen,
reading each vault's history at most once a minute;
`forgetPaymentHistory` clears it after a payment.

Telemetry events carry the requester's origin (or `scheme://`), the channel,
the evidence, the request kind, the outcome and its reason, and whether the
page could check its visibility (`visibility`: `tracked`, `untracked`,
`top-level`). A refused redirect names its destination the same way (origin
or `scheme://`). They never carry a challenge, credential, key, signature,
message text, transaction, or the path or query of a URL.

CSP reports for `frame-ancestors` name the portal itself, never the site
that framed it (browsers do not reveal it), so `/api/csp-report` only counts
framings. To find the apps to register, read the telemetry: events with
`registered: false` name each requesting origin and app scheme.

## Rollout

1. `stage: transition` (the committed policy): every recognised request is
   shown, with "Not registered" where it applies; telemetry and the framing
   counts show who uses the portal. Register those apps from the telemetry
   (`requester` of events with `registered: false`), and set `contentPolicy`
   to `enforce` once no content reports arrive.
2. `stage: enforce`: the enforce settings above. Program challenges, framing
   and redirects are then for registered apps only.

## Compatibility

How released SDKs fare against this portal under the committed policy
(`compat/` tests the web rows marked †; the e2e run drives web 3.4.0).

| SDK | Connect | Transactions | Wallet changes (32 bytes, no preview) | `signMessage` |
|---|---|---|---|---|
| web 2.0.1, 2.1.0 † | signs in; the key is reported when this portal stored it for the credential, else the SDK reads it from the chain (2.0.1 opens connect in a popup on every browser) | shown with the preview | "a change LazorKit can't show" | refused (raw text or bytes are not a recognised format) |
| web 3.0.0 to 3.3.0 († 3.3.0) | as above; the 32-byte connect challenge is not signed, and with the key stored there is no second prompt | shown | "a change LazorKit can't show" | refused |
| web 3.3.1 and later | the ownership proof is signed at sign-in | shown | "a change LazorKit can't show" | shown as text |
| mobile 1.5.x | signs in through the redirect; a key not reported is read from the chain | shown | "a change LazorKit can't show" | refused |
| mobile 2.0.0 to 2.3.0 | signs in through the redirect | shown | "a change LazorKit can't show" | refused |
| mobile 2.3.1 and later | signs in through the redirect | shown | "a change LazorKit can't show" | shown as text |

On the redirect channel (mobile), an app scheme that is not registered is
shown as "An app on this phone" in transition and refused at `enforce`; a
registered app scheme is shown the same way, since a scheme doesn't identify
one app. Under
`enforce`, transactions and wallet changes are for registered apps only.

## Development

Node 24 and pnpm 10.26 (`packageManager` and `.nvmrc`).

```bash
pnpm install --frozen-lockfile
pnpm dev               # https://localhost:3000, with /api served locally
pnpm test              # unit tests (node --test, no extra dependencies)
node scripts/record-chain-fixtures.ts
                       # re-record the devnet answers the chain-read tests replay
                       # (public devnet RPC, or RECORD_RPC_URL; never written to a file)
pnpm --dir compat install --frozen-lockfile && pnpm --dir compat test
                       # released SDKs (web 2.0.1, 2.1.0, 3.3.0) reading the portal's replies
pnpm typecheck:test
pnpm lint:checked      # lint of the security, page and api code
pnpm build
```

### End-to-end run

`e2e/run.mjs` drives the real SDK `DialogManager` against two local builds of
the portal (the committed policy, and the enforce settings), in Chromium with a
virtual authenticator, and a fake RPC. It covers connect, messages, a
transaction, approvals, refusals, covered and short frames, popups, redirects,
headers, the content policy and telemetry, and the screens' own behaviour
(the caution and danger steps, Escape, a passkey step that doesn't finish,
the address sheet, the way back after a redirect).

```bash
# a built @lazorkit/wallet (lazor-kit packages/react after `pnpm build`)
SDK_DIST=../lazor-kit/packages/react \
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
pnpm e2e
```

Results go to `e2e/.out/results.json`, screenshots to `e2e/.out/screens/`.

`e2e/typed.mjs` runs typed requests end to end on a local validator: a wallet
whose passkey the virtual authenticator holds, requests prepared with
`@lazorkit/sdk-legacy` and opened as the SDK opens them, the screen read,
Approve pressed (once after waiting more than 150 slots), and the transaction
finalized with the portal's slot and counter and sent. It also covers a
counter that moves before Approve, the caution and danger screens, a forged
envelope, a changed fragment and an unconfigured network. The validator runs
on its own ports and ledger, and is stopped and deleted at the end.

```bash
LAZORKIT_SO=<lazorkit-protocol devnet build>/lazorkit_program.so \
LAZORKIT_INIT_AUTHORITY=<lazorkit-protocol>/keys/devnet-init-authority.json \
TYPED_LEDGER=<an empty directory> PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
pnpm e2e:typed
```
