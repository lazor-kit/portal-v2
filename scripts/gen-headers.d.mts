import type { PortalPolicy } from '../src/security/policy.ts';
import type { Registry } from '../src/security/registry.ts';

type Header = { key: string; value: string };

export declare const REPORT_PATH: string;
export declare const CONNECT_SOURCES: readonly string[];
export declare function inlineScripts(html: string): string[];
export declare function inlineScriptHashes(html: string): string[];
export declare function registeredAncestors(registry: Registry, policy: PortalPolicy): string;
export declare function contentDirectives(scriptHashes: readonly string[]): string[];
export declare function headersFor(registry: Registry, policy: PortalPolicy, scriptHashes?: readonly string[]): Header[];
export declare function vercelConfig(registry: Registry, policy: PortalPolicy, scriptHashes?: readonly string[]): { headers: { source: string; headers: Header[] }[] };
export declare function render(registry: Registry, policy: PortalPolicy, scriptHashes?: readonly string[]): string;
