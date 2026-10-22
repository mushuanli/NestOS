import type { IFileSystem } from '@itookit/vfs-core';

export interface InstructionQueueSessions {
    mark(sessionId: string): Promise<void>;
    unmark(sessionId: string): Promise<void>;
    sessions(): Promise<string[]>;
}

const PATH = '/var/lib/kernel/instruction-queues.seq';

/** Mark before enqueueing. Stale marks cause a cold read, never a lost recovery. */
export function createInstructionQueueSessions(fs: IFileSystem): InstructionQueueSessions {
    return {
        async mark(sessionId) {
            if (!await fs.driver.exists(PATH)) {
                try { await fs.driver.createFile({ name: 'instruction-queues.seq', parentPath: '/var/lib/kernel', type: 'seqfile', recursive: true }); }
                catch (error) { if (!await fs.driver.exists(PATH)) throw error; }
            }
            await fs.meta.seq!.setEntry(PATH, sessionId, '1');
        },
        async sessions() {
            if (!await fs.driver.exists(PATH)) return [];
            const ids: string[] = [];
            await fs.meta.seq!.walkEntries(PATH, entry => { ids.push(entry.key); return true; });
            return ids;
        },
        async unmark(sessionId) {
            if (await fs.driver.exists(PATH)) await fs.meta.seq!.deleteEntry(PATH, sessionId);
        },
    };
}
