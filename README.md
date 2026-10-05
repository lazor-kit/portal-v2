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

### What is signed

The portal signs only these challenge formats (`src/security/challenge.ts`):

| Kind | Bytes | Shown as |
|---|---|---|
| Message | 58: `"LazorKit signed message v1"` ‖ SHA-256(tag ‖ UTF-8 text) | the text, only when it recomputes to the challenge; without text, a fingerprint and an explicit confirmation |
| Ownership proof | 59: `"LazorKit ownership proof v1"` ‖ 32 random bytes | "Confirm it's you"; signed during sign-in on connect |
| Transaction | 32, with a preview | the simulated preview, attributed to the requester |
| Approval | 32, no preview | a fingerprint and an explicit confirmation |

Anything else is refused with a reason, and the app is told why. The passkey
always signs the classified bytes, with the passkey `credentialId` names.
Control, zero-width and bidirectional characters in a message are shown as
their code points.

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

Every screen shows the requester: the origin (in full), or the app
destination a result returns to (scheme, host and path, never just the
scheme), with a "Registered" or "Not registered" badge.

### Approving

Approve and sign-in act only on a real click (`isTrusted`), and only 600 ms
after they become available (`src/security/gesture.ts`). The delay starts
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

Safari and Firefox do not report this. There, a transaction also needs an
explicit confirmation (approvals and messages without text always do), and
telemetry records `visibility: "untracked"`. Until `framing.mode` is
`enforce`, a site that is not registered can frame the portal on those
browsers without the portal being able to tell that it is covered.

### Optional handshake

An SDK may post `{ type: 'lazorkit:hello', v: 1, rid }` to the portal origin
from the window that opened or embeds it, with the same `rid` as the URL. The
portal answers `{ type: 'lazorkit:hello-ack', rid }` to the sender's origin,
and counts the sender's origin as evidence.

## Configuration

Both files are checked when the app is built and loaded
(`src/security/config.ts`); a change is a commit and a deploy.

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
      "programChallenges": true
    }
  ]
}
```

- `origins`: exact origins, `https://` (or `http://` on loopback), no path.
- `redirects`: a scheme (`acme://`) or a URL prefix; `/callback` covers
  `/callback/done` but not `/callbackx`.
- `programChallenges: false` refuses 32-byte challenges from that app.
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
  The page loads nothing from another origin (system fonts only).

Reports go to `/api/csp-report`. It never sets `X-Frame-Options` or
`Cross-Origin-Opener-Policy: same-origin`; apps that open the portal in a
popup should use `same-origin-allow-popups` if they set COOP.

## Server routes (`api/`)

| Route | Purpose |
|---|---|
| `POST /api/rpc?cluster=mainnet\|devnet` | Solana JSON-RPC for the preview: `getMultipleAccounts`, `simulateTransaction`, `getLatestBlockhash`, `isBlockhashValid` only; one request of at most 64 KiB, from the portal's own pages |
| `POST /api/telemetry` | one decision event, logged as a JSON line; listed fields only |
| `POST /api/csp-report` | CSP reports, logged as origins only |

`/api/rpc` and `/api/telemetry` answer pages of the origin serving them
(whatever domain the deployment is reached on, a staging domain included),
the deployment's own Vercel URLs, and `PORTAL_ORIGIN`.

Environment variables (Production and Preview):

| Name | Notes |
|---|---|
| `RPC_MAINNET_URL` | mainnet upstream, with its key; mark it sensitive; mainnet previews are unavailable without it |
| `RPC_DEVNET_URL` | devnet upstream, a keyed endpoint; required: on a Vercel production or preview deployment, devnet previews are unavailable without it (the public devnet RPC rate-limits the platform's shared addresses). Locally it defaults to `https://api.devnet.solana.com` |
| `PORTAL_ORIGIN` | optional further origins allowed to call `/api/rpc` and `/api/telemetry`, comma-separated |

Never put a secret in a `VITE_*` variable: those are compiled into the page.
Rate-limit `/api/rpc` and `/api/telemetry` at the edge.

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
| web 2.0.1, 2.1.0 † | signs in; the key is reported when this portal stored it for the credential, else the SDK reads it from the chain (2.0.1 opens connect in a popup on every browser) | shown with the preview | approval screen with confirmation | refused (raw text or bytes are not a recognised format) |
| web 3.0.0 to 3.3.0 († 3.3.0) | as above; the 32-byte connect challenge is not signed, and with the key stored there is no second prompt | shown | approval screen | refused |
| web 3.3.1 and later | the ownership proof is signed at sign-in | shown | approval screen | shown as text |
| mobile 1.5.x | signs in through the redirect; a key not reported is read from the chain | shown | approval screen | refused |
| mobile 2.0.0 to 2.3.0 | signs in through the redirect | shown | approval screen | refused |
| mobile 2.3.1 and later | signs in through the redirect | shown | approval screen | shown as text |

On the redirect channel (mobile), an app scheme that is not registered is
shown as "Not registered" in transition and refused at `enforce`. Under
`enforce`, transactions and wallet changes are for registered apps only.

## Development

Node 24 and pnpm 10.26 (`packageManager` and `.nvmrc`).

```bash
pnpm install --frozen-lockfile
pnpm dev               # https://localhost:3000, with /api served locally
pnpm test              # unit tests (node --test, no extra dependencies)
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
headers, the content policy and telemetry.

```bash
# a built @lazorkit/wallet (lazor-kit packages/react after `pnpm build`)
SDK_DIST=../lazor-kit/packages/react \
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
pnpm e2e
```

Results go to `e2e/.out/results.json`, screenshots to `e2e/.out/screens/`.
