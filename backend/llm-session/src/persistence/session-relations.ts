import { indexSessionSummary, removeSessionSummary } from './session-navigation-index';
import { FSError, type IFileSystem, type ISeqFileTransaction } from '@itookit/vfs-core';
import type { ConversationManifest, SessionFolder } from './types';
import { resolveSessionStorageRoot } from './session-storage-locations';

export const RELATIONS_PATH = '/var/lib/sessions/folders.seq';
const REVISION = 'relations-revision';
const deletionKey = (id: string) => `deleting/${id}`;
const metadataPath = async (tx: ISeqFileTransaction, id: string) => `${await resolveSessionStorageRoot(tx, id)}/session.seq`;
export interface SessionDeletion { id: string; parentSessionId: string | null; children: string[] }

export async function touchSessionRelations(tx: ISeqFileTransaction): Promise<void> {
    const revision = Number(await tx.getEntry(RELATIONS_PATH, REVISION) ?? 0);
    await tx.setEntry(RELATIONS_PATH, REVISION, String(revision + 1));
}
export async function assertSessionAvailable(tx: ISeqFileTransaction, id: string): Promise<void> {
    if (await tx.getEntry(RELATIONS_PATH, deletionKey(id))) throw new FSError('EBUSY', 'Session deletion is pending');
}
export async function readSessionMetadata(tx: ISeqFileTransaction, id: string): Promise<ConversationManifest> {
    const raw = await tx.getEntry(await metadataPath(tx, id), 'session');
    if (!raw) throw new FSError('ENOENT', 'Session not found');
    return JSON.parse(raw);
}

/** Serialize structural edits against a durable revision, including newly created Sessions. */
export class SessionRelations {
    constructor(private readonly fs: IFileSystem, private readonly list: () => Promise<ConversationManifest[]>,
        private readonly ensureWritable?: (ids: string[]) => Promise<void>) {}
    private async mutate<T>(run: (tx: ISeqFileTransaction, sessions: ConversationManifest[]) => Promise<T>,
        affected: (sessions: ConversationManifest[]) => string[]): Promise<T> {
        for (let attempt = 0; attempt < 8; attempt++) {
            const revision = await this.fs.meta.seq!.getEntry(RELATIONS_PATH, REVISION);
            const sessions = await this.list();
            await this.ensureWritable?.([...new Set(affected(sessions))]);
            const result = await this.fs.meta.seq!.transaction!(async tx => {
                if (await tx.getEntry(RELATIONS_PATH, REVISION) !== revision) return { retry: true } as const;
                const current = await Promise.all(sessions.map(item => readSessionMetadata(tx, item.id)));
                const value = await run(tx, current);
                await touchSessionRelations(tx);
                return { retry: false, value } as const;
            });
            if (!result.retry) return result.value;
        }
        throw new FSError('EBUSY', 'Session hierarchy changed; retry the operation');
    }
    async move(id: string, parent: string | null | undefined, folder?: string | null): Promise<void> {
        await this.mutate(async (tx, sessions) => {
            const source = required(sessions, id);
            const parentId = parent === undefined ? folder !== undefined && folder !== source.folder ? null : source.parentSessionId ?? null : parent;
            const destination = parentId ? required(sessions, parentId) : undefined;
            const subtree = descendants(sessions, id);
            if (parentId && subtree.has(parentId)) throw new FSError('EINVAL', 'Cannot move a Session into itself or its descendants');
            for (const member of subtree) await assertSessionAvailable(tx, member);
            if (parentId) await assertSessionAvailable(tx, parentId);
            const targetFolder = folder === undefined ? destination?.folder ?? source.folder ?? null : folder;
            if (destination && (destination.folder ?? null) !== targetFolder) throw new FSError('EINVAL', 'Child Sessions must share their parent folder');
            const folders: SessionFolder[] = JSON.parse(await tx.getEntry(RELATIONS_PATH, 'folders') ?? '[]');
            if (targetFolder && !folders.some(item => item.path === targetFolder)) throw new FSError('ENOENT', 'Session folder not found');
            if (folder === undefined && projectOf(folders, source.folder) && projectOf(folders, source.folder) !== projectOf(folders, targetFolder)) throw new FSError('EACCES', 'Cannot move Sessions between projects');
            for (const item of sessions.filter(item => subtree.has(item.id))) {
                await this.patch(tx, item.id, { folder: targetFolder, ...(item.id === id ? { parentSessionId: parentId } : {}) });
            }
        }, sessions => [...descendants(sessions, id), ...(parent ? [parent] : [])]);
    }
    async prepareDeletion(id: string): Promise<void> {
        await this.mutate(async (tx, sessions) => {
            if (await tx.getEntry(RELATIONS_PATH, deletionKey(id))) return;
            const session = required(sessions, id);
            const parent = session.parentSessionId ?? null;
            if (parent) await assertSessionAvailable(tx, parent);
            const children = sessions.filter(item => item.parentSessionId === id);
            for (const child of children) await assertSessionAvailable(tx, child.id);
            const intent: SessionDeletion = { id, parentSessionId: parent, children: children.map(item => item.id) };
            await tx.setEntry(RELATIONS_PATH, deletionKey(id), JSON.stringify(intent));
            for (const child of children) await this.patch(tx, child.id, { parentSessionId: parent });
        }, sessions => [id, ...sessions.filter(item => item.parentSessionId === id).map(item => item.id)]);
    }
    async pending(): Promise<SessionDeletion[]> {
        if (!await this.fs.driver.exists(RELATIONS_PATH)) return [];
        const result: SessionDeletion[] = [];
        await this.fs.meta.seq!.walkEntries(RELATIONS_PATH, entry => { result.push(JSON.parse(entry.value)); return true; }, { keyPrefix: 'deleting/' });
        return result;
    }
    async finishDeletion(id: string): Promise<void> {
        await this.fs.meta.seq!.transaction!(async tx => {
            await tx.deleteEntry(RELATIONS_PATH, deletionKey(id));
            await removeSessionSummary(tx, id);
            await touchSessionRelations(tx);
        });
    }
    private async patch(tx: ISeqFileTransaction, id: string, patch: Partial<ConversationManifest>): Promise<void> {
        const raw = await tx.getEntry(await metadataPath(tx, id), 'session');
        if (!raw) throw new FSError('ENOENT', 'Session not found');
        const current = JSON.parse(raw);
        const next = { ...current, ...patch, updatedAt: Date.now(), revision: current.revision + 1 };
        await tx.setEntry(await metadataPath(tx, id), 'session', JSON.stringify(next));
        await indexSessionSummary(tx, next, current);
    }
}

function required(sessions: ConversationManifest[], id: string): ConversationManifest {
    const session = sessions.find(item => item.id === id);
    if (!session) throw new FSError('ENOENT', 'Session not found');
    return session;
}
export function descendants(sessions: ConversationManifest[], id: string): Set<string> {
    const children = new Map<string, string[]>();
    for (const item of sessions) if (item.parentSessionId) children.set(item.parentSessionId, [...children.get(item.parentSessionId) ?? [], item.id]);
    const result = new Set<string>(), queue = [id];
    for (let i = 0; i < queue.length; i++) {
        const current = queue[i]!;
        if (result.has(current)) continue;
        result.add(current); queue.push(...children.get(current) ?? []);
    }
    return result;
}
function projectOf(folders: SessionFolder[], path?: string | null): string | null {
    return folders.filter(item => item.project && path && (path === item.path || path.startsWith(item.path + '/')))
        .sort((a, b) => b.path.length - a.path.length)[0]?.project?.id ?? null;
}
