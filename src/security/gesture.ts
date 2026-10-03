/**
 * Approval needs a deliberate, visible click:
 *
 * - the click is a real user action (`isTrusted`), never a script's;
 * - the approve button stays disabled for a short time after it appears (or
 *   comes back into view), so a click aimed at whatever was there before
 *   cannot land on it;
 * - in a frame, where the browser can report it (IntersectionObserver v2),
 *   the button is enabled only while it is fully visible: not covered,
 *   faded or transformed by the embedding page.
 */
import { useEffect, useState } from 'react';

export const ARM_DELAY_MS = 600;

export type GuardState = 'arming' | 'ready' | 'not-visible';

export function isTrustedActivation(event: { readonly isTrusted: boolean }): boolean {
  return event.isTrusted === true;
}

/** Whether this browser reports occlusion and visual effects (IntersectionObserver v2). */
export function supportsVisibilityTracking(): boolean {
  return typeof IntersectionObserverEntry !== 'undefined' && 'isVisible' in IntersectionObserverEntry.prototype;
}

/**
 * The state of a guarded button (`ready` is the only state in which it may
 * act), and the ref to attach to it.
 */
export function useActivationGuard(framed: boolean, active = true): { state: GuardState; ref: (el: HTMLElement | null) => void } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [armed, setArmed] = useState(false);
  const track = framed && supportsVisibilityTracking();
  const [visible, setVisible] = useState(!track);
  /** The observer has reported at least once; until then the button is arming, not hidden. */
  const [observed, setObserved] = useState(!track);

  useEffect(() => {
    if (!active || !track || !el) return;
    setVisible(false);
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean };
        setVisible(entry.isIntersecting && entry.isVisible === true);
        setObserved(true);
      },
      { threshold: [0, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, active, track]);

  // The delay starts again each time the button comes into view.
  const shown = !track || visible;
  useEffect(() => {
    setArmed(false);
    if (!active || !shown) return;
    const timer = window.setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [active, shown]);

  const state: GuardState = !shown ? (observed ? 'not-visible' : 'arming') : armed ? 'ready' : 'arming';
  return { state, ref: setEl };
}
