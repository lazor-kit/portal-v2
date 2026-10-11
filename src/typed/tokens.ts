/**
 * Tokens a typed screen names, keyed by cluster and mint. Any other mint is
 * "1 other token (Gh9Z…tKJr)", with decimals from the mint itself; a name
 * from on-chain metadata is never shown (anyone can call a mint "USDC").
 */
import type { ApprovalCluster } from '../approval/constants.ts';

export interface KnownToken {
  readonly symbol: string;
  readonly decimals: number;
}

const KNOWN: Readonly<Record<ApprovalCluster, Readonly<Record<string, KnownToken>>>> = {
  mainnet: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
    So11111111111111111111111111111111111111112: { symbol: 'WSOL', decimals: 9 },
  },
  devnet: {
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { symbol: 'USDC', decimals: 6 },
  },
};

export function knownToken(cluster: ApprovalCluster, mint: string): KnownToken | null {
  return KNOWN[cluster][mint] ?? null;
}
