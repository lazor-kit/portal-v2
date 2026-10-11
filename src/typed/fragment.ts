/**
 * The URL fragment is read once, at load, before the router starts: a typed
 * request (`#/?lk1=…`) is kept, then removed from the address bar with
 * `history.replaceState`. A parent frame or an opener can change a fragment
 * without reloading the page, so any later `hashchange` is tampering: the
 * page refuses the typed request it is showing.
 */
import { readApprovalFragment, type FragmentRead } from '../approval/envelope.ts';

interface Captured {
  readonly fragment: FragmentRead;
  /** The whole URL's length at load, for the size cap. */
  readonly urlLength: number;
}

let captured: Captured = { fragment: { kind: 'none' }, urlLength: 0 };
let tampered = false;
const listeners = new Set<() => void>();

export function captureFragment(win: Window = window): void {
  const fragment = readApprovalFragment(win.location.hash);
  captured = { fragment, urlLength: win.location.href.length };
  if (fragment.kind !== 'none') {
    win.history.replaceState(win.history.state, '', `${win.location.pathname}${win.location.search}#/`);
  }
  win.addEventListener('hashchange', () => {
    tampered = true;
    listeners.forEach((listener) => listener());
  });
}

export function capturedFragment(): Captured {
  return captured;
}

export function fragmentTampered(): boolean {
  return tampered;
}

/** Calls `listener` on a `hashchange` after load; returns the unsubscribe. */
export function onFragmentTampered(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
