import { ulid } from './ulid';
import { createSessionHost, type SessionLogger } from '../utils/host-ports';

type Metadata = Record<string, string | number | boolean | undefined>;

/** Emit only storage metadata; never include manifests, history or raw exceptions. */
export class SessionStorageTrace {
    private readonly operationId = ulid();
    private readonly started = performance.now();
    private stage = 'start';
    constructor(private readonly operation: string, private readonly metadata: Metadata,
        private readonly logger: SessionLogger = createSessionHost().logger) {}
    async step<T>(stage: string, work: () => Promise<T>): Promise<T> {
        this.stage = stage;
        this.emit('info', 'started');
        const result = await work();
        this.stage = stage;
        this.emit('info', 'success');
        return result;
    }
    async run<T>(work: (trace: SessionStorageTrace) => Promise<T>): Promise<T> {
        try { return await work(this); }
        catch (error) {
            const failure = error as { code?: string; storageReason?: string; storageRecordKey?: string; sessionId?: string; registered?: string; candidate?: string } | null;
            const conflict = failure?.storageReason === 'SESSION_STORAGE_IDENTITY_CONFLICT';
            this.emit('error', 'failure', { code: failure?.code ?? (error instanceof SyntaxError ? 'SESSION_STORAGE_PARSE_FAILED' : 'SESSION_STORAGE_UNEXPECTED'),
                reason: failure?.storageReason, recordKey: failure?.storageRecordKey, ...(conflict ? { sessionId: failure.sessionId,
                    registered: failure.registered, candidate: failure.candidate } : {}) });
            throw error;
        }
    }
    private emit(level: 'info' | 'error', outcome: string, extra: Metadata = {}): void {
        this.logger[level]('session.storage', { ...this.metadata, operation: this.operation, operationId: this.operationId,
            stage: this.stage, outcome, durationMs: Math.round(performance.now() - this.started), ...extra });
    }
}
