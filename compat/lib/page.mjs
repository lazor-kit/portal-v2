/**
 * A browser page (jsdom) for a released @lazorkit/wallet to run in, as an
 * app on APP that opens the portal on PORTAL. Import this before the SDK.
 */
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

export const APP = 'https://app.test';
export const PORTAL = 'https://portal.test';
export const RP_ID = 'portal.test';
export const RPC = 'https://rpc.test/';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: `${APP}/` });
export const { window } = dom;

// jsdom has <dialog> but not its modal methods, nor an iframe's sandbox token list.
window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
window.HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
Object.defineProperty(window.HTMLIFrameElement.prototype, 'sandbox', {
  get() {
    const tokens = () => (this.getAttribute('sandbox') ?? '').split(' ').filter(Boolean);
    return {
      add: (...names) => this.setAttribute('sandbox', [...new Set([...tokens(), ...names])].join(' ')),
      contains: (name) => tokens().includes(name),
    };
  },
});
for (const name of ['window', 'document', 'navigator', 'localStorage', 'sessionStorage', 'CustomEvent', 'MessageEvent', 'HTMLElement', 'HTMLIFrameElement']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true, writable: true });
}
if (!globalThis.crypto) globalThis.crypto = webcrypto;

/**
 * Popups the page opened, newest last: each a window of its own on the URL
 * asked for (the SDK checks a reply's source against it), closed by `close()`.
 */
export const popups = [];
window.open = (url) => {
  const popup = new JSDOM('<!doctype html><html><body></body></html>', { url: String(url) }).window;
  popup.close = () => {
    Object.defineProperty(popup, 'closed', { value: true, configurable: true });
  };
  popups.push({ url: String(url), popup });
  return popup;
};

/** Closes the page and its popups, so nothing they scheduled keeps the test running. */
export function closePage() {
  for (const { popup } of popups) popup.close();
  window.close();
}
console.debug = () => {};
console.info = () => {};
console.log = () => {};
console.warn = () => {};
console.error = () => {};
// Nothing reaches the network: the chain is scripted (lib/chain.mjs), and
// anything else fails the call that made it.
globalThis.fetch = async (url) => {
  throw new Error(`unexpected fetch ${url}`);
};
