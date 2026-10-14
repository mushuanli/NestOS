import { TWIN_KINDS, type TwinMemoryKind, type TwinSourceSpec } from './domain';
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
