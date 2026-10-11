import { createHash } from 'node:crypto';
import { FSError } from '@itookit/vfs-core';
import type { Cell, Commit, Observation, Page } from '../protocol';

export interface ConflictMetadata {
    observationKind: Observation['kind']; observationIndex: number; observationCount: number;
    mutationCount: number; recordId: string; expectedCount?: number; actualCount?: number;
}

/** Identify the conflicting location without logging paths, field names or values. */
export class RecordConflictError extends FSError {
    readonly conflict: ConflictMetadata;
    constructor(input: Commit, index: number, current: Cell[] | Page) {
        super('ECONFLICT', 'Records changed during the transaction');
        const read = input.observations[index];
        const base = { observationKind: read.kind, observationIndex: index,
            observationCount: input.observations.length, mutationCount: input.mutations.length };
        if (read.kind === 'get') {
            const changed = read.values.findIndex((value, i) => JSON.stringify(value) !== JSON.stringify((current as Cell[])[i]));
            const request = read.requests[Math.max(changed, 0)];
            this.conflict = { ...base, recordId: locationId(request?.path ?? '', request?.field ?? '') };
        } else {
            this.conflict = { ...base, recordId: locationId(read.path, read.options?.prefix ?? ''),
                expectedCount: read.page.total, actualCount: (current as Page).total };
        }
    }
}

function locationId(path: string, field: string): string {
    return createHash('sha256').update(JSON.stringify([path, field])).digest('hex');
}
