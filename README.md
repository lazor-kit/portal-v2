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

Evidence that disagrees refuses the request. Every reply is posted with that
origin as its target (`src/security/reply.ts`), so the browser delivers it only
to a window showing the origin on screen. With no origin, nothing is sent and
the user is told to close the window. A small inline script in `index.html`
records the origin and type of messages that arrive before the app has loaded
(never their contents).

On the redirect channel the destination must be registered for an app, or
allowed by the policy while the registry fills (`src/security/redirect.ts`).
Script, data, file and similar schemes are never redirect destinations.

Every screen shows the requester: the origin (in full) or the app's scheme,
with a "Registered" or "Not registered" badge.

### Approving

Approve and sign-in act only on a real click (`isTrusted`), stay disabled for
600 ms after they appear, and, in a frame on browsers that report it
(IntersectionObserver v2), only while they are fully visible.

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
| `framing.mode` | `report` (any https page may frame; others than registered are reported) or `enforce` (registered only) |
| `framing.allowLoopback` | allow `localhost` and `127.0.0.1` for local development |

The `enforce` settings are `transaction` and `approval` at `registered`,
both redirect rules at `deny`, and `framing.mode` at `enforce`.

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

It sets `Content-Security-Policy: frame-ancestors …` (plus a report-only
policy in `report` mode) with reports to `/api/csp-report`. It never sets
`X-Frame-Options` or `Cross-Origin-Opener-Policy: same-origin`; apps that open
the portal in a popup should use `same-origin-allow-popups` if they set COOP.

## Server routes (`api/`)

| Route | Purpose |
|---|---|
| `POST /api/rpc?cluster=mainnet\|devnet` | Solana JSON-RPC for the preview: `getMultipleAccounts`, `simulateTransaction`, `getLatestBlockhash`, `isBlockhashValid` only; one request of at most 64 KiB, from the portal origin |
| `POST /api/telemetry` | one decision event, logged as a JSON line; listed fields only |
| `POST /api/csp-report` | CSP reports, logged as origins only |

Environment variables:

| Name | Notes |
|---|---|
| `RPC_MAINNET_URL` | mainnet upstream, with its key; mark it sensitive; mainnet previews are unavailable without it |
| `RPC_DEVNET_URL` | devnet upstream; defaults to `https://api.devnet.solana.com` |
| `PORTAL_ORIGIN` | the origin(s) allowed to call `/api/rpc` and `/api/telemetry`, comma-separated, e.g. `https://portal.lazor.sh` (the deployment's own Vercel URLs are allowed too) |

Never put a secret in a `VITE_*` variable: those are compiled into the page.
Rate-limit `/api/rpc` and `/api/telemetry` at the edge.

Telemetry events carry the requester's origin (or `scheme://`), the channel,
the evidence, the request kind, the outcome and its reason. They never carry a
challenge, credential, key, signature, message text, transaction, or the path
or query of a URL.

## Development

Node 24 and pnpm 10.26 (`packageManager` and `.nvmrc`).

```bash
pnpm install --frozen-lockfile
pnpm dev               # https://localhost:3000, with /api served locally
pnpm test              # unit tests (node --test, no extra dependencies)
pnpm typecheck:test
pnpm lint:checked      # lint of the security, page and api code
pnpm build
```

### End-to-end run

`e2e/run.mjs` drives the real SDK `DialogManager` against two local builds of
the portal (the committed policy, and the enforce settings), in Chromium with a
virtual authenticator, and a fake RPC. It covers connect, messages, a
transaction, approvals, refusals, popups, redirects, headers and telemetry.

```bash
# a built @lazorkit/wallet (lazor-kit packages/react after `pnpm build`)
SDK_DIST=../lazor-kit/packages/react \
PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
pnpm e2e
```

Results go to `e2e/.out/results.json`, screenshots to `e2e/.out/screens/`.
