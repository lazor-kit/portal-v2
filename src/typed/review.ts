/**
 * A typed request's chain state while its screen is open, outside React so a
 * test can drive it and count its reads:
 *
 *   - read once when the request is shown (`readTypedChain`), refusing what
 *     would fail;
 *   - then a snapshot of the authority's counter and the cluster's Clock
 *     every `SNAPSHOT_INTERVAL_MS`, and the snapshots' verdict every
 *     `VERDICT_INTERVAL_MS`;
 *   - `bind()` picks the slot and counter from the latest snapshot,
 *     synchronously, for the Approve click (the challenge is recomputed
 *     there, from the request and that snapshot).
 *
 * A request is known by its canonical text (`encodeApprovalRequest`, which is
 * byte for byte the fragment it was decoded from). The page evaluates the
 * request again on every message from the app (the SDK syncs credentials up
 * to six times in its first 3.5 s), which yields a new but identical object:
 * showing it again changes nothing and reads nothing. Only another request,
 * Try again, or the screen closing starts over.
 *
 * A refresh changes nothing shown, so it never re-arms the button; only a
 * snapshot that is too old, or a node behind the SDK's counter, turns it off.
 */
import { encodeApprovalRequest, type ApprovalRequest } from '../approval/envelope.ts';
import type { Transport } from '../chain/transport.ts';
import { bindAtApprove, SNAPSHOT_INTERVAL_MS, snapshotVerdict, type BindResult } from './approve.ts';
import type { ProgramConfig } from './programs.ts';
import { readDeploySlot, readFloor, readSnapshot, readTypedChain, type Snapshot, type TypedChainView } from './reads.ts';
import { needsHoldings } from './screen.ts';

export type TypedState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'refused'; readonly code: 'wrong-network' | 'request-invalid' | 'chain-unavailable' | 'stale-counter'; readonly reason?: string }
  | { readonly phase: 'ready'; readonly view: TypedChainView };

/** What the screen shows: the state, and whether Approve can sign now. A new object only when one of them changes. */
export interface TypedView {
  readonly state: TypedState;
  readonly canSign: boolean;
}

/** How often the snapshots' verdict (and whether Approve can sign) is worked out. */
export const VERDICT_INTERVAL_MS = 250;

/** The request's identity: its canonical text. */
export const requestKey = (req: ApprovalRequest): string => encodeApprovalRequest(req);

/**
 * What a page reads once and remembers across requests: the binary per
 * cluster and program (DESIGN §3.1; a read that fails is read again on the
 * next try), and the newest slot seen per cluster, from fresh answers only.
 * Every later read is asked of a node at or past that slot, so a lagging
 * node behind the RPC's load balancer can't take the page back in time.
 */
export interface PageReads {
  readonly deploySlots: Map<string, Promise<number | null>>;
  readonly observedSlots: Map<string, number>;
}

export const newPageReads = (): PageReads => ({ deploySlots: new Map(), observedSlots: new Map() });
const thisPage = newPageReads();

export interface TypedReviewDeps {
  readonly transportFor: (cluster: ApprovalRequest['cluster']) => Transport;
  readonly configFor: (cluster: ApprovalRequest['cluster']) => ProgramConfig | undefined;
  /** `performance.now()`-style milliseconds. */
  readonly now?: () => number;
  readonly page?: PageReads;
}

const LOADING: TypedState = { phase: 'loading' };

export class TypedReview {
  private readonly transportFor: TypedReviewDeps['transportFor'];
  private readonly configFor: TypedReviewDeps['configFor'];
  private readonly now: () => number;
  private readonly page: PageReads;

  private key: string | null = null;
  private request: ApprovalRequest | null = null;
  /** Bumped whenever what runs stops: an answer for an earlier run is dropped. */
  private run = 0;
  private timers: ReturnType<typeof setInterval>[] = [];
  private view: TypedView = { state: LOADING, canSign: false };
  private readonly listeners = new Set<() => void>();

  private snapshot: Snapshot | null = null;
  /** Approve can't be tapped now (the passkey prompt is open, or the answer went): the snapshots' verdict waits. */
  private signing = false;
  /** When snapshots started, the last usable one arrived, since when the passkey reads as removed, and since when the node is behind. */
  private startedAt = 0;
  private lastGoodAt: number | null = null;
  private goneSince: number | null = null;
  private behindSince: number | null = null;

  constructor(deps: TypedReviewDeps) {
    this.transportFor = deps.transportFor;
    this.configFor = deps.configFor;
    this.now = deps.now ?? (() => performance.now());
    this.page = deps.page ?? thisPage;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getView = (): TypedView => this.view;

  /**
   * The request on screen, or null when none is. The same request again (by
   * its canonical text) does nothing; another one starts over. With null,
   * what was shown stays, and nothing more is read.
   */
  show(request: ApprovalRequest | null): void {
    const key = request ? requestKey(request) : null;
    if (key === this.key) return;
    this.stop();
    this.key = key;
    this.request = request;
    this.reset();
    if (request) this.read(request);
  }

  setSigning(signing: boolean): void {
    this.signing = signing;
  }

  /** For the Approve click: the binding from the latest snapshot, or why not yet. */
  readonly bind = (): BindResult => {
    if (!this.request || this.view.state.phase !== 'ready') return { kind: 'wait', reason: 'no-snapshot' };
    return bindAtApprove(this.request, this.snapshot, this.now());
  };

  /** Try again: everything read afresh. */
  readonly retry = (): void => {
    this.stop();
    this.reset();
    if (this.request) this.read(this.request);
  };

  /** The screen closed: nothing more is read. */
  dispose(): void {
    this.stop();
    this.key = null;
    this.request = null;
  }

  private stop(): void {
    this.run++;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  private reset(): void {
    this.snapshot = null;
    this.behindSince = null;
    this.lastGoodAt = null;
    this.goneSince = null;
    this.set({ canSign: false });
  }

  /** Changes the view, and tells the screen, only when something in it changed. */
  private set(next: { state?: TypedState; canSign?: boolean }): void {
    const state = next.state ?? this.view.state;
    const canSign = next.canSign ?? this.view.canSign;
    const sameState = state === this.view.state || (state.phase === 'loading' && this.view.state.phase === 'loading');
    if (sameState && canSign === this.view.canSign) return;
    this.view = { state: sameState ? this.view.state : state, canSign };
    for (const listener of this.listeners) listener();
  }

  private observe(cluster: string, slot: bigint): void {
    const n = Number(slot);
    if (Number.isSafeInteger(n) && n > (this.page.observedSlots.get(cluster) ?? 0)) this.page.observedSlots.set(cluster, n);
  }

  private read(request: ApprovalRequest): void {
    const run = this.run;
    this.set({ state: LOADING });
    const transport = this.transportFor(request.cluster);
    const { deploySlots, observedSlots } = this.page;
    const key = `${request.cluster}:${request.programId}`;
    const deploySlot = () => {
      let deploy = deploySlots.get(key);
      if (!deploy) {
        // A failure is not "another binary": it is thrown, and the request is chain-unavailable (Try again).
        deploy = readDeploySlot(transport, request.programId, { minContextSlot: readFloor(request, observedSlots.get(request.cluster)) }).catch((error: unknown) => {
          deploySlots.delete(key);
          throw error;
        });
        deploySlots.set(key, deploy);
      }
      return deploy;
    };
    readTypedChain(transport, request, {
      config: this.configFor(request.cluster),
      deploySlot,
      needsHoldings,
      observedSlot: observedSlots.get(request.cluster),
    }).then(
      (result) => {
        if (result.ok) this.observe(request.cluster, result.view.clock.slot);
        if (run !== this.run) return;
        if (!result.ok) {
          this.set({ state: { phase: 'refused', code: result.code, reason: result.reason } });
          return;
        }
        this.set({ state: { phase: 'ready', view: result.view } });
        this.snapshots(request, run);
      },
      () => {
        if (run === this.run) this.set({ state: { phase: 'refused', code: 'chain-unavailable' } });
      },
    );
  }

  /** A snapshot now and every `SNAPSHOT_INTERVAL_MS`, and their verdict, while the request is ready. */
  private snapshots(request: ApprovalRequest, run: number): void {
    const transport = this.transportFor(request.cluster);
    this.startedAt = this.now();
    this.lastGoodAt = null;
    this.goneSince = null;
    const tick = async () => {
      try {
        const floor = readFloor(request, this.page.observedSlots.get(request.cluster));
        const next = await readSnapshot(transport, request, this.now, floor);
        if (run !== this.run) return;
        if (!next) {
          this.goneSince ??= this.now();
          return;
        }
        this.goneSince = null;
        this.observe(request.cluster, next.slot);
        this.lastGoodAt = next.at;
        this.snapshot = next;
        if (next.counter + 1 < request.counter) {
          this.behindSince ??= this.now();
        } else {
          this.behindSince = null;
        }
      } catch {
        // A failed refresh, or one from a node behind the newest slot seen,
        // leaves the last snapshot to age out; with none usable for too
        // long, the verdict below refuses (chain-unavailable, Try again).
      }
    };
    const evaluate = () => {
      if (run !== this.run || this.signing) return;
      const verdict = snapshotVerdict(
        { startedAt: this.startedAt, lastGoodAt: this.lastGoodAt, goneSince: this.goneSince, behindSince: this.behindSince },
        this.now(),
      );
      if (verdict.kind === 'refuse') {
        this.stop();
        this.set({ state: { phase: 'refused', code: verdict.code, reason: verdict.reason }, canSign: false });
        return;
      }
      this.set({ canSign: bindAtApprove(request, this.snapshot, this.now()).kind === 'sign' });
    };
    void tick().then(evaluate);
    this.timers.push(
      setInterval(() => void tick(), SNAPSHOT_INTERVAL_MS),
      setInterval(evaluate, VERDICT_INTERVAL_MS),
    );
  }
}
