import { checkOperation, operationScope, FSError, type OperationOptions } from '@itookit/vfs-core';
import type { ProjectService } from '@itookit/app-contracts/services';

/** A read-only native snapshot, not a runnable local Session/Kernel bundle. */
export async function exportRemoteSession(projects: ProjectService, folder: string, profileId: string, sessionId: string, options?: OperationOptions) {
    const scope = operationScope({timeoutMs: 20_000, ...options});
    try { return await exportSnapshot(projects, folder, profileId, sessionId, scope.options); } finally { scope.dispose(); }
}
async function exportSnapshot(projects: ProjectService, folder: string, profileId: string, sessionId: string, options: OperationOptions) {
    const project = await projects.forFolder(folder), remote = projects.remoteMounts;
    if (!project || !remote) throw new FSError('ENOENT', 'Remote project unavailable');
    const root = remote.list(project.project.id).find(m => m.at === '/');
    if (!root?.serverId || !root.serverProjectId || !root.connectionId) throw new FSError('ECAPABILITY', 'Stable remote identity unavailable');
    const fingerprint = JSON.stringify(remote.list(project.project.id));
    const client = await remote.projectHarness(project.project.id, options);
    const turns: unknown[] = [], cursors = new Set<string>(); let cursor: string | undefined, bytes = 0;
    try {
        let session;
        do {
            checkOperation(options);
            const page = await client.read(profileId, sessionId, {...options, cursor, toolDetail: 'summary'});
            session ??= page.session; bytes += new TextEncoder().encode(JSON.stringify(page.turns)).byteLength;
            if (bytes > 16 * 1024 * 1024 || cursors.size >= 128) throw new FSError('EFBIG', 'Native export capacity reached');
            turns.unshift(...page.turns ?? []); cursor = page.nextCursor ?? undefined;
            if (cursor && cursors.has(cursor)) throw new FSError('EIO', 'History cursor did not advance');
            if (cursor) cursors.add(cursor);
        } while (cursor);
        if (fingerprint !== JSON.stringify(remote.list(project.project.id))) throw new FSError('ECONFLICT', 'Project authorization changed');
        const content = JSON.stringify({format: 'nestos-native-history', version: 1, executable: false, toolDetail: 'summary',
            source: {connectionId: root.connectionId, serverId: root.serverId, projectId: root.serverProjectId, profileId, sessionId},
            exportedAt: Date.now(), session, turns}, null, 2);
        return {name: 'native-session-' + encodeURIComponent(sessionId) + '.json', content, mimeType: 'application/json'};
    } finally { await client.close(); }
}
