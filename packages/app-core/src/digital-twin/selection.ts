import { TWIN_KINDS, type TwinMemoryKind, type TwinSourceSpec } from './domain';
import { matchesRules, resourceKey, type TwinScanRules } from './scan-rules';
import type { TwinDiscoveredSource } from './domain';

export interface TwinSelectionTarget extends TwinSourceSpec { directory?: boolean; }
export const TWIN_SELECTION_TYPES = ['all', 'profile', 'relationships', 'projects', 'events', 'goals'] as const;
export type TwinSelectionType = typeof TWIN_SELECTION_TYPES[number];
export const selectionKinds = (type: TwinSelectionType): TwinMemoryKind[] => {
    const kinds: Record<TwinSelectionType, readonly TwinMemoryKind[]> = {
        all: TWIN_KINDS, profile: ['fact', 'preference', 'role', 'experience', 'constraint'],
        relationships: ['relationship'], projects: ['project', 'decision', 'question'], events: ['event'], goals: ['goal', 'commitment'],
    };
    if (!kinds[type]) throw new Error('TWIN_INVALID_SCAN_RULE');
    return [...kinds[type]];
};
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
