import type { PortalPolicy } from '../src/security/policy.ts';
import type { Registry } from '../src/security/registry.ts';

export declare const REPORT_PATH: string;
export declare function registeredAncestors(registry: Registry, policy: PortalPolicy): string;
export declare function headersFor(registry: Registry, policy: PortalPolicy): { key: string; value: string }[];
export declare function vercelConfig(registry: Registry, policy: PortalPolicy): { headers: { source: string; headers: { key: string; value: string }[] }[] };
export declare function render(registry: Registry, policy: PortalPolicy): string;
