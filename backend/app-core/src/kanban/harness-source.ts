import type {HarnessClient, HarnessSession} from '@itookit/cells-driver/harness';
import type {KanbanScanSession, KanbanScanText} from '@itookit/kanban/contracts';
import type {KanbanScanSource} from '@itookit/kanban/discovery';
import {requireValue} from './validation';

/** A client must already be bound to one authorized remote project. */
export function createHarnessKanbanSource(options: {
    client: HarnessClient; profileId: string; projectId: string;
    identity(nativeId: string): string; nativeId(identity: string): string;
    scannerOwned(sessionId: string): boolean;
}): KanbanScanSource {
    const {client, profileId} = options;
    const session = (value: HarnessSession): KanbanScanSession => ({id: options.identity(value.id),
        revision: revision(value), updatedAt: value.updatedAt, idleSince: null,
        activity: value.activeTurnId || ['active', 'running', 'busy'].includes(value.status ?? '') ? 'active'
            : value.statusDetails?.activeFlags?.length ? 'waiting' : value.status === 'idle' || value.status === 'notLoaded' && value.writerLock?.status === 'not-held' ? 'idle' : 'unknown',
        archived: value.archived === true, scannerOwned: options.scannerOwned(options.identity(value.id))});
    const inspect = async (id: string) => {requireValue(client.digest, 'SESSION_DIGEST_REQUIRED');
        return session((await client.digest(profileId, options.nativeId(id), {metadataOnly: true})).session);};
    return {projectId: options.projectId, kind: 'remote', inspect,
        async list(includeArchived) {
            const result: KanbanScanSession[] = [];
            for (const archived of includeArchived ? [false, true] : [false]) {
                let cursor: string | undefined; const seen = new Set<string>();
                do {
                    const page = await client.list(profileId, {archived, ...(cursor ? {cursor} : {})});
                    for (const row of page.sessions) result.push(row.status === 'notLoaded' ? await inspect(options.identity(row.id)) : session(row)); cursor = page.nextCursor ?? undefined;
                    requireValue(!cursor || !seen.has(cursor), 'SESSION_CURSOR_STALLED'); if (cursor) seen.add(cursor);
                    requireValue(result.length <= 10000, 'SESSION_CAPACITY');
                } while (cursor);
            }
            return [...new Map(result.map(row => [row.id, row])).values()];
        },
        read: async (source, maxBytes) => readDigest(source, maxBytes, options, session),
    };
}
async function readDigest(source: KanbanScanSession, maxBytes: number,
    options: Parameters<typeof createHarnessKanbanSource>[0], convert: (value: HarnessSession) => KanbanScanSession): Promise<KanbanScanText> {
    requireValue(options.client.digest, 'SESSION_DIGEST_REQUIRED');
    let cursor: string | undefined, boundary: string | undefined, bytes = 0, omitted = 0;
    const messages: KanbanScanText['messages'] = [], seen = new Set<string>();
    for (let page = 0; page < 256; page++) {
        const value = await options.client.digest(options.profileId, options.nativeId(source.id), {cursor, expectedRevision: boundary});
        boundary ??= value.revision; requireValue(convert(value.session).revision === source.revision, 'SOURCE_CHANGED');
        omitted += value.omittedUnclassified;
        bytes += new TextEncoder().encode(JSON.stringify(value.messages)).length; requireValue(bytes <= maxBytes, 'SCAN_INPUT_LIMIT');
        messages.unshift(...value.messages.map(m => ({id: m.id, role: m.role, text: m.text})));
        if (!value.nextCursor) return {session: source, messages, complete: omitted === 0};
        requireValue(!seen.has(value.nextCursor), 'SESSION_CURSOR_STALLED'); seen.add(value.nextCursor); cursor = value.nextCursor;
    }
    throw new Error('SESSION_PAGE_LIMIT');
}
function revision(value: HarnessSession): string {
    return JSON.stringify([value.id, value.updatedAt, value.lastTurnId, value.lastTurnResult, value.activeTurnId, value.archived, value.status]);
}
