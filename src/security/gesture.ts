/**
 * Approval needs a deliberate, visible click:
 *
 * - the click is a real user action (`isTrusted`), never a script's;
 * - the button is enabled only `ARM_DELAY_MS` after it becomes available,
 *   and that delay starts again whenever the situation changes under the
 *   pointer: the button is enabled (a simulation finishes, a box is
 *   ticked), the page becomes visible again, a top-level window gains focus
 *   (a popup brought to the front), or, in a frame, the mouse enters the
 *   frame. A click aimed at whatever was there before cannot land on it;
 * - in a frame, where the browser can report it (IntersectionObserver v2),
 *   the whole decision surface (the requester, what is asked, and the
 *   buttons) must be fully on screen and not covered, faded or transformed
 *   by the embedding page. Where the browser cannot report it (Safari and
 *   Firefox today), screens that move funds also ask for an explicit
 *   confirmation, and telemetry records that visibility was not tracked.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

export const ARM_DELAY_MS = 600;
/** Share of the surface that must be on screen; 1 allows for sub-pixel rounding. */
export const FULLY_VISIBLE = 0.99;

export type GuardState = 'arming' | 'ready' | 'not-visible';

/**
 * The element holding everything a decision rests on (the requester bar, the
 * request and the buttons). Every guarded button checks that it is visible.
 */
export const DecisionSurface = createContext<HTMLElement | null>(null);

export function isTrustedActivation(event: { readonly isTrusted: boolean }): boolean {
  return event.isTrusted === true;
}

/** Whether this browser reports occlusion and visual effects (IntersectionObserver v2). */
export function supportsVisibilityTracking(): boolean {
  return typeof IntersectionObserverEntry !== 'undefined' && 'isVisible' in IntersectionObserverEntry.prototype;
}

/** Whether an IntersectionObserver v2 entry shows the surface fully on screen and unobstructed. */
export function fullyVisible(entry: { isIntersecting: boolean; intersectionRatio: number; isVisible?: boolean }): boolean {
  return entry.isIntersecting && entry.isVisible === true && entry.intersectionRatio >= FULLY_VISIBLE;
}

/**
 * Whether a pointerover event is the mouse entering this document (from the
 * embedding page, another frame or another window): it comes from no element
 * of this document.
 */
export function isMouseEntry(
  event: { pointerType: string; relatedTarget: EventTarget | null },
  inThisDocument: (target: EventTarget) => boolean,
): boolean {
  if (event.pointerType !== 'mouse') return false;
  return event.relatedTarget === null || !inThisDocument(event.relatedTarget);
}

export interface ActivationGuard {
  /** `ready` is the only state in which the button may act. */
  readonly state: GuardState;
  /** Checked again at the click itself, against the latest events. */
  canActivate(event: { readonly isTrusted: boolean }): boolean;
}

/**
 * The guard for a button that approves: `active` is false while the button
 * is disabled for another reason (busy, an unticked box, a preview still
 * loading); turning true starts the delay.
 */
export function useActivationGuard({ framed, active }: { framed: boolean; active: boolean }): ActivationGuard {
  const surface = useContext(DecisionSurface);
  const track = framed && supportsVisibilityTracking();
  const [visible, setVisible] = useState(!track);
  /** The observer has reported at least once; until then the button is arming, not hidden. */
  const [observed, setObserved] = useState(!track);
  const visibleRef = useRef(!track);
  /** When the button may act; Infinity while it may not. */
  const readyAt = useRef(Number.POSITIVE_INFINITY);
  const [epoch, setEpoch] = useState(0);
  const [armed, setArmed] = useState(false);

  const rearm = useCallback(() => {
    readyAt.current = performance.now() + ARM_DELAY_MS;
    setEpoch((n) => n + 1);
  }, []);
  const disarm = useCallback(() => {
    readyAt.current = Number.POSITIVE_INFINITY;
    setEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!track || !surface) return;
    visibleRef.current = false;
    setVisible(false);
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1] as IntersectionObserverEntry & { isVisible?: boolean };
        const now = fullyVisible(entry);
        visibleRef.current = now;
        setVisible(now);
        setObserved(true);
      },
      { threshold: [0, FULLY_VISIBLE, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
    );
    observer.observe(surface);
    return () => observer.disconnect();
  }, [surface, track]);

  // Becoming available (enabled and, where tracked, visible) starts the delay.
  const shown = !track || visible;
  useEffect(() => {
    if (active && shown) rearm();
    else disarm();
  }, [active, shown, rearm, disarm]);

  // Events that change what is under the pointer start it again.
  useEffect(() => {
    const onVisibility = () => (document.visibilityState === 'visible' ? rearm() : disarm());
    const onFocus = () => rearm();
    const onPointerOver = (event: PointerEvent) => {
      if (isMouseEntry(event, (target) => target instanceof Node && document.contains(target))) rearm();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // A frame gains focus with the very click that should act, so focus
    // re-arms top-level windows only; in a frame the mouse entering does.
    if (framed) document.addEventListener('pointerover', onPointerOver, true);
    else window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerover', onPointerOver, true);
      window.removeEventListener('focus', onFocus);
    };
  }, [framed, rearm, disarm]);

  // The rendered state follows the latest deadline.
  useEffect(() => {
    setArmed(false);
    if (!Number.isFinite(readyAt.current)) return;
    const timer = window.setTimeout(() => setArmed(true), Math.max(0, readyAt.current - performance.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [epoch]);

  const activeRef = useRef(active);
  activeRef.current = active;
  const canActivate = useCallback(
    (event: { readonly isTrusted: boolean }) =>
      isTrustedActivation(event) &&
      activeRef.current &&
      visibleRef.current &&
      document.visibilityState === 'visible' &&
      performance.now() >= readyAt.current,
    [],
  );

  const state: GuardState = !shown ? (observed ? 'not-visible' : 'arming') : armed && active ? 'ready' : 'arming';
  return { state, canActivate };
}
