import {createModuleLogger, randomUUID} from '@itookit/common';
import {FSError, type IFileSystem} from '@itookit/vfs-core';

const log = createModuleLogger('notes-migration');
/** Move through VFS so metadata follows content; never overwrite either namespace. */
export async function migrateNotes(home: IFileSystem): Promise<void> {
    if (!await home.driver.exists('/minds')) return;
    const operationId = randomUUID(), started = Date.now(); let stage = 'preflight';
    try {
        const moves: Array<{from: string; parent: string}> = [], empty: string[] = [];
        if (!await home.driver.exists('/notes')) {
            stage = 'rename'; await home.driver.rename('/minds', 'notes');
        } else {
            await plan(home, '/minds', '/notes', moves, empty);
            stage = 'move';
            for (const move of moves) await home.driver.move([move.from], move.parent);
            stage = 'cleanup';
            for (const path of empty) {
                if ((await home.driver.getChildren(path)).length) throw new FSError('EBUSY', 'Notes migration source changed');
                await home.driver.delete([path]);
            }
        }
        log.info('notes.migrate', {operationId, stage: 'complete', result: 'success', count: moves.length, durationMs: Date.now() - started});
    } catch (error) {
        log.error('notes.migrate', {operationId, stage, result: 'failure', code: error instanceof FSError ? error.code : 'NOTES_MIGRATION_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
async function plan(fs: IFileSystem, source: string, target: string, moves: Array<{from: string; parent: string}>, empty: string[]): Promise<void> {
    for (const node of await fs.driver.getChildren(source)) {
        const destination = `${target}/${node.name}`, existing = await fs.driver.getNode(destination);
        if (!existing) moves.push({from: node.path, parent: target});
        else if (node.type === 'directory' && existing.type === 'directory') await plan(fs, node.path, destination, moves, empty);
        else throw new FSError('EEXIST', `Notes migration conflict: ${destination}`);
    }
    empty.push(source);
}
