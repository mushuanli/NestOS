import {createModuleLogger, randomUUID} from '@itookit/common';
import type {IFileSystem} from '@itookit/vfs-core';
import type {ProjectConversationPort} from '@itookit/app-contracts/services';
import {recoverRemoteConversationQueues, type RemoteConversationRecoveryTarget, type RemoteRecoveryDiagnostic} from './remote-conversation-recovery';

const log = createModuleLogger('remote-conversation-recovery');
const transient = new Set(['EIO', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH']);

/** Retry observation attachment only; the persisted journal remains the recovery index. */
export class RemoteConversationRecoveryLoop {
    private pending?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private retryTargets = new Set<string>();
    private retryAll = false;
    private delay = 15000;
    private closed = false;
    constructor(private readonly fs: IFileSystem,
        private readonly open: (target: RemoteConversationRecoveryTarget) => Promise<ProjectConversationPort>,
        private readonly diagnostic: (event: RemoteRecoveryDiagnostic) => void) {}

    recover(): Promise<void> {return this.run(true);}
    async close(): Promise<void> {
        this.closed = true; clearTimeout(this.timer); await this.pending?.catch(() => {}); this.retryTargets.clear();
    }
    private run(all: boolean): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.pending) return this.pending;
        clearTimeout(this.timer);
        const targets = this.retryTargets; all ||= this.retryAll;
        this.retryTargets = new Set(); this.retryAll = false;
        this.pending = this.scan(all, targets).finally(() => {this.pending = undefined; this.schedule();});
        return this.pending;
    }
    private async scan(all: boolean, targets: Set<string>): Promise<void> {
        const started = Date.now();
        try {
            await recoverRemoteConversationQueues(this.fs, this.open, this.diagnostic, {
                include: target => !this.closed && (all || targets.has(JSON.stringify(target))),
                onDeferred: (target, error) => {if (canRetry(error)) this.retryTargets.add(JSON.stringify(target));},
            });
        } catch (error) {
            this.retryAll = canRetry(error);
            const code = (error as {code?: string})?.code;
            const event: RemoteRecoveryDiagnostic = {operationId: randomUUID(), stage: 'scan', result: 'deferred',
                code: transient.has(code ?? '') ? code : 'RECOVERY_SCAN_FAILED', durationMs: Date.now() - started};
            log.warn('remote.queue.recover', event); this.diagnostic(event);
            throw error;
        }
    }
    private schedule(): void {
        if (this.closed || !this.retryAll && !this.retryTargets.size) {this.delay = 15000; return;}
        this.timer = setTimeout(() => {void this.run(false).catch(() => {});}, this.delay);
        this.delay = Math.min(this.delay * 2, 60000);
    }
}
function canRetry(error: unknown): boolean {
    const failure = error as {code?: string; diagnostic?: {reason?: string}};
    return transient.has(failure?.code ?? '') || failure?.diagnostic?.reason === 'catalog-not-loaded';
}
