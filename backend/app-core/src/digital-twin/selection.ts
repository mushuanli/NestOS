import { matchesRules, resourceKey, type TwinScanRules } from './scan-rules';
import type { TwinDiscoveredSource } from './domain';

import type { TwinSelectionTarget } from '@itookit/app-contracts';
export { TWIN_SELECTION_TYPES, selectionKinds, type TwinSelectionTarget, type TwinSelectionType } from '@itookit/app-contracts';
/** Encode literals before adding our own directory wildcard, so names cannot become patterns. */
export function selectionPattern(target: TwinSelectionTarget): string {
    if (!['file', 'session', 'harness-session'].includes(target.kind) || !target.target || (target.directory && target.kind !== 'file')) throw new Error('TWIN_INVALID_SOURCE');
    return 'resource:' + resourceKey({ ...target, target: target.directory ? target.target.replace(/\/$/, '') + '/' : target.target }) + (target.directory ? '**' : '');
}
/** The most specific menu selection controls extraction types inside broader rules. */
export function selectedRules(resource: TwinDiscoveredSource, rules: TwinScanRules, all: TwinScanRules[]): boolean {
    if (!matchesRules(resource, rules)) return false;
    const selected = all.filter(item => item.selection && matchesRules(resource, item));
    if (!selected.length) return true;
    return !!rules.selection && rules.include[0].length === Math.max(...selected.map(item => item.include[0].length));
}
