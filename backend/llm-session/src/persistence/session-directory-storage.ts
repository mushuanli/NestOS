import type { ResolvedStorageBinding, SessionStorageResolver, StorageBindingRef } from '@itookit/durable-kernel';
import type { IFileSystem } from '@itookit/vfs-core';
import { sessionExecutionRoot } from './session-storage-layout';

export const SESSION_DIRECTORY_STORAGE_KIND = 'session-directory';

/** Runtime storage binding: no chat UI, filename lookup or legacy migration. */
export class SessionDirectoryStorageResolver implements SessionStorageResolver {
    readonly kind = SESSION_DIRECTORY_STORAGE_KIND;
    constructor(private readonly fs: IFileSystem) {}

    async resolve(reference: StorageBindingRef): Promise<ResolvedStorageBinding> {
        if (reference.kind !== this.kind) throw new Error('Unsupported Session storage kind');
        const locator = reference.locator;
        if (!locator || Array.isArray(locator) || typeof locator !== 'object' || typeof locator.sessionId !== 'string') {
            throw new Error('Session directory storage requires sessionId');
        }
        return { fs: this.fs, rootPath: sessionExecutionRoot(locator.sessionId) };
    }
}

export function sessionDirectoryStorage(sessionId: string): StorageBindingRef {
    sessionExecutionRoot(sessionId);
    return { kind: SESSION_DIRECTORY_STORAGE_KIND, locator: { sessionId } };
}
