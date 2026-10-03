// A test page that drives the portal through the SDK's own DialogManager,
// and through hand-made requests (raw) the SDK would never send.
import { DialogManager, signedMessageChallenge } from '@lazorkit/wallet';

const params = new URLSearchParams(location.search);
const portalUrl = params.get('portal') ?? 'http://localhost:4173';

type Outcome = { ok: true; value: unknown } | { ok: false; name: string; message: string };

async function run(fn: (dm: DialogManager) => Promise<unknown>): Promise<Outcome> {
  const dm = new DialogManager({ portalUrl });
  try {
    return { ok: true, value: await fn(dm) };
  } catch (e) {
    const error = e as Error;
    return { ok: false, name: error?.name ?? 'Error', message: String(error?.message ?? e) };
  } finally {
    dm.destroy();
  }
}

const bytes = (list: number[]) => new Uint8Array(list);

/** A frame showing `src`; resolves with the first message the frame posts, or a timeout. */
function frame(src: string, timeoutMs = 20_000): Promise<{ origin?: string; data?: unknown; timeout?: true }> {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.allow = `publickey-credentials-get ${portalUrl}; publickey-credentials-create ${portalUrl}`;
    iframe.id = 'raw';
    iframe.style.cssText = 'width:420px;height:640px;border:0';
    const done = (value: { origin?: string; data?: unknown; timeout?: true }) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.remove();
      resolve(value);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === iframe.contentWindow) done({ origin: e.origin, data: e.data });
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => done({ timeout: true }), timeoutMs);
    iframe.src = src;
    document.body.appendChild(iframe);
  });
}

/** The portal with a hand-made query, in a frame. */
const raw = (query: string, timeoutMs?: number) => frame(`${portalUrl}/?${query}`, timeoutMs);
/** A frame whose first page, on `bouncer`'s origin, navigates the frame to the portal. */
const bounced = (bouncer: string, query: string, timeoutMs?: number) =>
  frame(`${bouncer}?to=${encodeURIComponent(`${portalUrl}/?${query}`)}`, timeoutMs);

Object.assign(window, {
  lk: {
    portalUrl,
    connect: (challenge?: string) => run((dm) => dm.openConnect(challenge ? { challenge } : {})),
    signMessage: (message: string | number[], credentialId: string) =>
      run((dm) => dm.openSignMessage(typeof message === 'string' ? message : bytes(message), credentialId)),
    sign: (challenge: string, preview: string, credentialId: string, cluster?: 'devnet' | 'mainnet') =>
      run((dm) => dm.openSign(challenge, preview, credentialId, cluster)),
    challengeOf: (message: string | number[]) => Array.from(signedMessageChallenge(typeof message === 'string' ? message : bytes(message))),
    raw,
    bounced,
  },
});

document.getElementById('status')!.textContent = 'ready';
