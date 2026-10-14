import type { ISessionRepository } from '@itookit/llm-session';
import type { FileSystemMount, FileSystemView } from '@itookit/vfs-core';

/** The only intrinsic user file grant. History and system services have separate APIs. */
export function createSessionAttachmentMounts(repository: ISessionRepository) {
    const sources = new Map<string, Promise<FileSystemView>>();
    return {
        async forSession(sessionId: string): Promise<FileSystemMount[]> {
            await repository.getManifest(sessionId);
            if (!sources.has(sessionId)) sources.set(sessionId, repository.openAttachments(sessionId));
            try { return [{ mountId: 'attachments', at: '/attachments', fs: await sources.get(sessionId)!, access: 'rw' }]; }
            catch (error) { sources.delete(sessionId); throw error; }
        },
        async dispose() { for (const source of await Promise.allSettled(sources.values())) if (source.status === 'fulfilled') await source.value.dispose(); sources.clear(); },
    };
}
