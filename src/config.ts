/**
 * The portal policy and app registry, checked when the bundle is built and
 * again when it loads. Changing either is a commit and a deploy.
 */
import policyJson from '../config/portal-policy.json';
import registryJson from '../config/registry.json';
import { parsePolicy, parseRegistry } from '@/security/config';

export const policy = parsePolicy(policyJson);
export const registry = parseRegistry(registryJson);
