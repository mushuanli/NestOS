import { FSError } from '@itookit/vfs-core';
import { KernelError, KernelErrorCode } from '@itookit/durable-kernel';
import type { ISessionRepository } from '@itookit/llm-session';

export interface SessionLifecycleDependencies { repository: ISessionRepository; kernel: import('@itookit/durable-kernel/contracts').KernelViewPort }
export interface SessionLifecycleOptions {
    /**
     * Bound for the whole close step: both the `closeSession` call (which waits for in-flight
     * Effects to confirm their stop) and the wait for the Kernel to reach `closed`; default 30s.
     */
    closeTimeoutMs?: number;
    closePollMs?: number;
}

/**
 * Single entry point for Session closure: close the Kernel Session and wait until the
 * stop is really confirmed. Deleting is the destructive sibling that additionally
 * removes Kernel storage and the repository records. Every step keeps the Session
 * intact when it fails.
 */
export class SessionLifecycleService {
    constructor(
        private readonly deps: SessionLifecycleDependencies,
        private readonly options: SessionLifecycleOptions = {},
    ) {}

    /**
     * Stop a Session (cancelling running Tasks and waiting for the external stop to be
     * confirmed) while keeping every record, so the history stays readable.
     */
    async closeSession(sessionId: string): Promise<void> {
        await this.deps.repository.getManifest(sessionId);
        await this.closeAndWait(sessionId, 'records were kept');
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this.deps.repository.assertStructuralWritable([sessionId]);
        const pending = await this.deps.repository.pendingSessionDeletions();
        if (!pending.some(item => item.id === sessionId)) await this.deps.repository.getManifest(sessionId);
        await this.closeAndWait(sessionId, 'nothing was deleted');
        await this.deps.repository.prepareSessionDeletion(sessionId);
        try { await this.deps.kernel.removeSession(sessionId); }
        catch (error) { if (!isMissingSession(error)) throw error; }
        await this.deps.repository.deleteSession(sessionId);
    }

    async deleteFolder(path: string, recursive = false): Promise<void> {
        if (!recursive) {
            await this.deps.repository.deleteFolder(path, false);
            return;
        }
        const sessions = (await this.deps.repository.list())
            .filter(session => session.folder === path || session.folder?.startsWith(`${path}/`));
        for (const session of sessions) await this.deleteSession(session.id);
        await this.deps.repository.deleteFolder(path, true);
    }

    /** Close cancels running Tasks; deleting before it settles would race live state. */
    private async closeAndWait(sessionId: string, onFailure: string): Promise<void> {
        const timeoutMs = this.options.closeTimeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        try {
            if (await settlesBefore(this.waitUntilClosed(sessionId, deadline), deadline)) return;
            throw new Error(`Close did not complete within ${timeoutMs}ms`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new FSError('EBUSY', `Session ${sessionId} could not be closed: ${reason}; ${onFailure}`);
        }
    }

    private async waitUntilClosed(sessionId: string, deadline: number): Promise<void> {
        try { await this.deps.kernel.closeSession(sessionId, true); }
        catch (error) { if (!isMissingSession(error)) throw error; }
        while (Date.now() < deadline) {
            const stat = await this.stat(sessionId);
            if (!stat || stat.phase === 'closed') return;
            await new Promise(resolve => setTimeout(resolve,
                Math.min(this.options.closePollMs ?? 50, Math.max(0, deadline - Date.now()))));
        }
        throw new Error('Session close deadline exceeded');
    }

    private async stat(sessionId: string) {
        try {
            return await this.deps.kernel.sessionStat(sessionId);
        } catch (error) {
            if (isMissingSession(error)) return null;
            throw error;
        }
    }
}

/**
 * True when `work` settled before `deadline`. A late settlement is still observed (so it can
 * never become an unhandled rejection); the caller only learns that it was not in time.
 */
function settlesBefore(work: Promise<unknown>, deadline: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        void work.then(() => { clearTimeout(timer); resolve(true); },
            error => { clearTimeout(timer); reject(error); });
    });
}

/** A Session without Kernel records has nothing to close; the repository still owns it. */
function isMissingSession(error: unknown): boolean {
    return error instanceof KernelError && error.code === KernelErrorCode.SESSION_NOT_FOUND;
}
