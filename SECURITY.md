# Security Policy

## Reporting a vulnerability

Please do not open a public issue, pull request or discussion for a
vulnerability.

- **GitHub private vulnerability reporting** is enabled for this repository:
  [report a vulnerability](https://github.com/lazor-kit/portal-v2/security/advisories/new).
- **Contact:** [SECURITY CONTACT]

Include the affected page or endpoint, the commit, the browser and platform,
the SDK and version that opened the portal, and steps that reproduce the
issue.

## Scope

In scope: the LazorKit passkey portal in this repository, the page that
`@lazorkit/wallet` and `@lazorkit/wallet-mobile-adapter` open to create a
passkey, sign in and sign. That includes:

- how a request is read and classified (`src/security`, `src/approval`,
  `src/typed`) and what the passkey is asked to sign;
- what the approval screens show (`src/pages`, `src/components`);
- how results are returned to the app (frame, popup and redirect channels);
- the serverless endpoints in `api/`, the response headers (`vercel.json`),
  and the configuration in `config/` (registered sites, policy, program ids).

Out of scope here:

- The on-chain program and the protocol SDKs:
  [lazor-kit/lazorkit-protocol](https://github.com/lazor-kit/lazorkit-protocol).
- The wallet SDKs:
  [lazor-kit/lazor-kit](https://github.com/lazor-kit/lazor-kit).
- Applications built on top of LazorKit, and third-party dependencies (please
  report to upstream).

## Audit status

**The portal has not been externally audited.**

What is checked on every change, in CI (`.github/workflows/ci.yml`): type
checks and lint, the unit tests in `test/` (request classification, typed
requests and their parity with the SDK, replies, previews, chain reads,
headers), a check that released SDK versions read the portal's replies, the
generated response headers, and a secret scan of the source tree and the
built bundle. End-to-end runs are in `e2e/`.
