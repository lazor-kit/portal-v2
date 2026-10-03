/**
 * Which network a transaction preview belongs to.
 *
 * The request names a cluster (`clusterSimulation`) or none (devnet). The
 * preview carries a recent blockhash, and a blockhash is valid on one cluster
 * only, so checking it settles the network the app actually built the
 * transaction on.
 */
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js';

export type Cluster = 'mainnet' | 'devnet';

export interface ResolvedCluster {
  /** The cluster to simulate on and to show. */
  readonly cluster: Cluster;
  /** `request`: as the app asked; `default`: none asked, devnet; `preview`: the preview's blockhash says otherwise. */
  readonly source: 'request' | 'default' | 'preview';
  /** The preview's blockhash is valid on `cluster`. */
  readonly verified: boolean;
  /** The app asked for one cluster, and the preview belongs to the other. */
  readonly mismatch: boolean;
  /**
   * The network is known: the preview's blockhash is valid on `cluster`, or
   * the app named `cluster` and no check contradicts it. When it is not
   * known (devnet only by default, or the blockhash was found invalid there
   * while the other cluster could not be checked), a failed simulation says
   * nothing about the transaction, and is not shown as a likely failure.
   */
  readonly known: boolean;
}

/** Whether `blockhash` is valid on `cluster`; null when it could not be checked. */
export type BlockhashCheck = (cluster: Cluster, blockhash: string) => Promise<boolean | null>;

export function parseCluster(value: string | null): Cluster | null {
  return value === 'mainnet' || value === 'devnet' ? value : null;
}

/** The recent blockhash of a serialized transaction (legacy or v0) or bare message; null when it is neither. */
export function previewBlockhash(bytes: Uint8Array): string | null {
  try {
    return VersionedTransaction.deserialize(bytes).message.recentBlockhash;
  } catch {
    // Not a transaction: maybe a message on its own.
  }
  try {
    return VersionedMessage.deserialize(bytes).recentBlockhash;
  } catch {
    return null;
  }
}

export async function resolveCluster(requested: Cluster | null, blockhash: string | null, check: BlockhashCheck): Promise<ResolvedCluster> {
  const first: Cluster = requested ?? 'devnet';
  const other: Cluster = first === 'mainnet' ? 'devnet' : 'mainnet';
  const source = requested ? 'request' : 'default';
  if (!blockhash) return { cluster: first, source, verified: false, mismatch: false, known: requested !== null };
  const safe = (cluster: Cluster) => check(cluster, blockhash).catch(() => null);
  const [onFirst, onOther] = await Promise.all([safe(first), safe(other)]);
  if (onFirst === true) return { cluster: first, source, verified: true, mismatch: false, known: true };
  if (onOther === true) return { cluster: other, source: 'preview', verified: true, mismatch: requested !== null, known: true };
  // Not settled by the blockhash. The app's word stands unless the
  // blockhash was found invalid on its cluster and the other could not be
  // checked (the preview may well belong there).
  const contradicted = onFirst === false && onOther === null;
  return { cluster: first, source, verified: false, mismatch: false, known: requested !== null && !contradicted };
}
