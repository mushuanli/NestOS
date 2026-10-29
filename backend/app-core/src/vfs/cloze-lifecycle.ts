import type { IFileSystem, ISeqFileTransaction } from '@itookit/vfs-core';
import { CLOZE_SRS_PATH, clozeDocumentPrefix, parseClozeStorageKey } from '@itookit/app-contracts';
import { createModuleLogger, randomUUID } from '@itookit/common';

const log = createModuleLogger('cloze-lifecycle');
function failureCode(error: unknown): string {
    const value = (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message;
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'CLOZE_LIFECYCLE_FAILED';
}
const storagePath = CLOZE_SRS_PATH;
function under(path: string, root: string): boolean { return path === root || path.startsWith(root + '/'); }
interface Move { oldPath: string; newPath: string }

/** Maintain records for unopened documents too. Only existing state is touched. */
export async function updateClozeRecords(notes: IFileSystem, moves: Move[], deleted: string[]): Promise<number> {
    if (!notes.meta.seq || !await notes.driver.exists(storagePath)) return 0;
    if (!notes.meta.seq.transaction) throw new Error('CLOZE_RECORD_TRANSACTION_UNAVAILABLE');
    return notes.meta.seq.transaction(async tx => {
        const changes: Array<{ key: string; value: string; target?: string }> = [];
        await tx.walkEntries(storagePath, entry => {
            const record = parseClozeStorageKey(entry.key);
            if (!record) return true;
            const path = record.path;
            if (deleted.some(root => under(path, root))) changes.push({ ...entry });
            else collectMove(changes, entry, record, path, moves);
            return true;
        });
        await commitChanges(tx, changes);
        return changes.length;
    });
}

function collectMove(changes: Array<{ key: string; value: string; target?: string }>,
    entry: { key: string; value: string }, record: { path: string; key: string }, path: string, moves: Move[]): void {
    const move = moves.find(candidate => under(path, candidate.oldPath));
    if (!move) return;
    const targetPath = move.newPath + path.slice(move.oldPath.length);
    const target = clozeDocumentPrefix(targetPath) + record.key;
    changes.push({ ...entry, target });
}

async function commitChanges(tx: ISeqFileTransaction, changes: Array<{ key: string; value: string; target?: string }>): Promise<void> {
    for (const change of changes) await tx.deleteEntry(storagePath, change.key);
    for (const change of changes) {
        if (!change.target) continue;
        if (await tx.getEntry(storagePath, change.target) !== null) throw new Error('CLOZE_RECORD_TARGET_EXISTS');
        await tx.setEntry(storagePath, change.target, change.value);
    }
}

/** Subscribe for the runtime lifetime, independently of editor/view lifetimes. */
export function trackNotesCloze(notes: IFileSystem): () => Promise<void> {
    let pending = Promise.resolve();
    const errors: unknown[] = [];
    const enqueue = (operation: string, moves: Move[], deleted: string[]) => {
        if (![...moves.map(move => move.oldPath), ...deleted].some(path => !under(path, '/.nestos'))) return;
        const operationId = randomUUID(), started = Date.now();
        pending = pending.then(async () => {
            const count = await updateClozeRecords(notes, moves, deleted);
            if (count) log.info('cloze.lifecycle', { operation, operationId, stage: 'records', result: 'success', count, durationMs: Date.now() - started });
        }).catch(error => {
            errors.push(error);
            log.error('cloze.lifecycle', { operation, operationId, stage: 'records', result: 'failure',
                code: failureCode(error), durationMs: Date.now() - started });
        });
    };
    const stops = [notes.on('node:deleted', event => enqueue('cloze.delete', [], event.payload.requestedPaths)),
        notes.on('node:renamed', event => enqueue('cloze.rename', event.payload.nodes, [])),
        notes.on('node:moved', event => enqueue('cloze.move', event.payload.nodes, []))];
    return async () => {
        stops.forEach(stop => stop()); await pending;
        if (errors.length) throw new AggregateError(errors, 'Cloze record maintenance failed');
    };
}
