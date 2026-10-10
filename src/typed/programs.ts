/**
 * config/programs.json: the LazorKit v2 program on each cluster, the slot it
 * was last deployed at, and what that binary does. Binary-dependent claims
 * ("Your account blocks it", Unix-time expiry) are made only when the feature
 * is listed here and the chain agrees the deployed binary is this one (the
 * program data's last-deploy slot equals `lastDeploySlot`). The devnet
 * upgrade and the change to this file ship together.
 */
import { LAZORKIT_PROGRAM } from '../chain/layout.ts';
import type { ApprovalCluster } from '../approval/constants.ts';

export type Feature = 'wallet-bound-challenge' | 'd13' | 'nonowner-invariants' | 'time-expiry';
export const FEATURES: readonly Feature[] = ['wallet-bound-challenge', 'd13', 'nonowner-invariants', 'time-expiry'];

export interface ProgramConfig {
  readonly programId: string;
  readonly lastDeploySlot: number;
  readonly features: readonly Feature[];
}

export type Programs = Partial<Readonly<Record<ApprovalCluster, ProgramConfig>>>;

export class ProgramsConfigError extends Error {
  constructor(message: string) {
    super(`programs.json: ${message}`);
    this.name = 'ProgramsConfigError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The file, checked: a cluster absent means typed requests for it are refused (`wrong-network`). */
export function parsePrograms(json: unknown): Programs {
  if (!isObj(json)) throw new ProgramsConfigError('must be an object');
  const out: Partial<Record<ApprovalCluster, ProgramConfig>> = {};
  for (const [cluster, raw] of Object.entries(json)) {
    if (cluster !== 'devnet' && cluster !== 'mainnet') throw new ProgramsConfigError(`unknown cluster ${cluster}`);
    if (!isObj(raw)) throw new ProgramsConfigError(`${cluster} must be an object`);
    const keys = Object.keys(raw).sort().join(',');
    if (keys !== 'features,lastDeploySlot,programId') throw new ProgramsConfigError(`${cluster} must have exactly programId, lastDeploySlot and features`);
    if (raw.programId !== LAZORKIT_PROGRAM[cluster]) throw new ProgramsConfigError(`${cluster}.programId must be ${LAZORKIT_PROGRAM[cluster]}`);
    if (typeof raw.lastDeploySlot !== 'number' || !Number.isSafeInteger(raw.lastDeploySlot) || raw.lastDeploySlot < 0) {
      throw new ProgramsConfigError(`${cluster}.lastDeploySlot must be a slot`);
    }
    if (!Array.isArray(raw.features) || !raw.features.every((f) => (FEATURES as readonly unknown[]).includes(f)) || new Set(raw.features).size !== raw.features.length) {
      throw new ProgramsConfigError(`${cluster}.features must be distinct names from ${FEATURES.join(', ')}`);
    }
    out[cluster] = { programId: raw.programId as string, lastDeploySlot: raw.lastDeploySlot, features: raw.features as Feature[] };
  }
  return out;
}

/** Features a kind can't be shown without; missing → `wrong-network`. */
export const REQUIRED_FEATURES: Readonly<Record<'createSession' | 'revokeSession' | 'removeAuthority', readonly Feature[]>> = {
  createSession: ['wallet-bound-challenge', 'd13', 'time-expiry'],
  revokeSession: ['wallet-bound-challenge'],
  removeAuthority: ['wallet-bound-challenge'],
};
