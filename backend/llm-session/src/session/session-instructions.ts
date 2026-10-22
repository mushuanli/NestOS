import type { Kernel } from '@itookit/durable-kernel';
import type { InstructionQueueEdit, SessionInstruction, SessionInstructionInput, SessionInstructionQueue } from '../contracts/instruction-queue';
import type { TaskInput } from '../core/types';
import type { InstructionQueueSessions } from '../persistence/instruction-queue-sessions';
import type { PersistedRound } from '../persistence/round-types';
import { resolveSessionExecutionMode } from './session-execution-mode';
import type { SessionInstructionQueues } from './instruction-queue';
import type { SessionInstructionRuntime } from './session-instruction-runtime';
import { queueError } from './instruction-queue-rules';
import { hasCommittedSubmission } from '../persistence/submission-receipt';
import type { SessionRegistry } from './session-registry';
import type { SessionRunCoordinator } from './session-run-coordinator';
import type { RoundOperations } from './round-operations';
import type { SessionExecutionActivity } from './session-execution-activity';

/** Wires the queue to Session execution without depending on the currently visible editor. */
export class SessionInstructions {
    readonly queues: SessionInstructionQueues;
    private readonly runtime: SessionInstructionRuntime;
    private readonly pending = new Set<Promise<unknown>>();
    private readonly release: () => void;
    private closed = false;
    constructor(private readonly registry: SessionRegistry, private readonly runs: SessionRunCoordinator,
        private readonly rounds: RoundOperations, private readonly kernel: Kernel,
        private readonly canWrite: ((id: string) => Promise<boolean>) | undefined, sessions: InstructionQueueSessions | undefined,
        activity: SessionExecutionActivity) {
        this.runtime = activity.instructionRuntime(kernel, registry.host, sessions);
        this.queues = this.runtime.queues;
        this.release = this.runtime.attach({
            hasSession: id => !!registry.getSessionRuntime(id),
            assertWritable: id => this.assertWritable(id), branch: async id => (await registry.engine.getManifest(id)).currentBranch,
            ready: id => this.ready(id), submit: (id, item) => this.submit(id, item),
            recover: (id, item) => this.recover(id, item), prepare: (id, item, immediate) => this.prepare(id, item, immediate),
            capture: (id, item, source) => this.persistAttachments(id, item, source),
            previouslyAccepted: (id, item, digest) => this.previouslyAccepted(id, item, digest), changed: queue => this.changed(queue),
            idle: id => this.notify(id),
        });
    }

    send(input: TaskInput): Promise<string> {
        if (this.closed) return Promise.reject(queueError('QUEUE_CLOSED', 'Session execution context is closed'));
        const source = { ...input, files: input.files.map(file => ({ name: file.name, type: file.type, path: file.path, size: file.size,
            fileRef: typeof Blob !== 'undefined' && file instanceof Blob ? file : file.fileRef })) };
        const operation = this.queues.enqueue(input.sessionId, source);
        this.pending.add(operation);
        void operation.finally(() => { this.pending.delete(operation); this.notify(input.sessionId); }).catch(() => {});
        return operation;
    }

    snapshot(id: string): SessionInstructionQueue | undefined { return this.runtime.snapshot(id); }
    hasPending(): boolean { return this.pending.size > 0 || this.runtime.hasPending(id => !!this.registry.getSessionRuntime(id)); }
    edit(id: string, edit: InstructionQueueEdit) { return this.queues.edit(id, edit); }
    pause(id: string) { return this.queues.pause(id); }
    restore(id: string) { return this.queues.restore(id); }
    dispose(): void { this.closed = true; this.release(); }
    async whenIdle(): Promise<void> {
        while (this.pending.size) await Promise.allSettled([...this.pending]);
        await this.queues.whenIdle();
    }

    private changed(queue: SessionInstructionQueue): void {
        this.registry.eventBus.emitSession(queue.sessionId, { type: 'instructions:changed', payload: queue });
        this.notify(queue.sessionId);
    }

    private notify(sessionId: string): void {
        const queue = this.snapshot(sessionId);
        this.registry.eventBus.emitGlobal({ type: 'session_instructions_changed', payload: {
            sessionId, count: queue?.items.length ?? 0, paused: queue?.paused ?? false,
        } });
    }

    private async prepare(id: string, item: SessionInstruction, immediate: boolean): Promise<SessionInstruction> {
        await this.runs.assertCanSubmit(id);
        const input = await resolveSessionExecutionMode(this.registry.engine, { ...item, sessionId: id }, this.registry.host.translate);
        const bound = await this.runs.bindQueuedInstruction(id, { ...item, overrides: input.overrides, sendIntent: input.sendIntent });
        if (immediate) await this.runs.validateSubmission({ ...bound, sessionId: id, instructionConnectionBinding: bound.connectionBinding });
        return bound;
    }

    private async previouslyAccepted(id: string, item: SessionInstruction, digest: string): Promise<boolean> {
        const submission = item.sendIntent?.submission;
        if (!submission || !await hasCommittedSubmission(this.registry.engine, id, submission)) return false;
        const raw = await this.registry.engine.readDocument(id, `round-${item.id}.json`);
        const round = JSON.parse(raw!) as PersistedRound;
        if (!round.submissionDigest) throw queueError('QUEUE_IDENTITY_UNVERIFIABLE', 'This historical request has no content receipt; inspect history before submitting with a new identity');
        if (round.submissionDigest !== digest) throw queueError('QUEUE_CONFLICT', 'Submission identity already belongs to another request');
        return true;
    }

    private async assertWritable(id: string): Promise<void> {
        if (this.canWrite && !await this.canWrite(id)) throw queueError('QUEUE_READ_ONLY', 'Session is owned by another host; this host can only read it');
    }

    private async ready(id: string): Promise<boolean> {
        if (this.runs.isActive(id)) return false;
        const activity = await this.kernel.sessionActivity(id);
        return activity.sessionStatus === 'open' && activity.pending.cleanup === 0
            && ['running', 'queued', 'created', 'waiting', 'paused', 'blocked'].every(phase => !activity.counts[phase as keyof typeof activity.counts]);
    }

    private async submit(id: string, item: SessionInstruction): Promise<string> {
        if (this.closed) throw queueError('QUEUE_CLOSED', 'Session execution context is closed');
        const state = this.registry.getSessionState(id), runtime = this.registry.getSessionRuntime(id);
        if (!state || !runtime) throw queueError('QUEUE_SESSION_MISSING', 'Session execution context is unavailable');
        await this.assertHistoryReady(id);
        await this.registry.reloadSessionData(id, state);
        return this.rounds.sendInSession({ ...item, sessionId: id, instructionId: item.id, instructionBranch: item.branch,
            instructionConnectionBinding: item.connectionBinding }, state, runtime);
    }

    private async assertHistoryReady(id: string): Promise<void> {
        const manifest = await this.registry.engine.getManifest(id);
        if (!manifest.currentHead) return;
        const raw = await this.registry.engine.readDocument(id, `round-${manifest.currentHead}.json`);
        const round = raw ? JSON.parse(raw) as PersistedRound : undefined;
        if (!round || ['pending', 'running', 'waiting'].includes(round.status)) {
            throw queueError('QUEUE_HISTORY_INCOMPLETE', 'The previous execution has no confirmed history result; resolve it before retrying the queued instruction');
        }
    }

    private async persistAttachments(sessionId: string, queued: SessionInstruction, input: SessionInstructionInput): Promise<SessionInstruction> {
        for (const [index, file] of input.files.entries()) {
            if (!file.fileRef) continue;
            const name = `${queued.id}-${index}${file.name.match(/\.[a-zA-Z0-9]{1,16}$/)?.[0] ?? ''}`;
            await this.persistFile(sessionId, name, file.fileRef, queued.id);
            queued.text = queued.text.replaceAll(`@asset/${file.name}`, `@asset/${name}`);
            queued.files[index] = { ...queued.files[index], name };
        }
        return queued;
    }

    private async persistFile(sessionId: string, name: string, file: Blob, operationId: string): Promise<void> {
        const started = Date.now(); let stage = 'attachment-read';
        try {
            const bytes = await file.arrayBuffer(); stage = 'attachment-write';
            await this.registry.engine.writeAttachment(sessionId, name, bytes);
            this.registry.host.logger.debug('Queued attachment persisted', { operation: 'session.instructions', stage,
                outcome: 'success', sessionId, operationId, bytes: bytes.byteLength, durationMs: Date.now() - started });
        } catch (error) {
            const code = stage === 'attachment-read' ? 'QUEUE_ATTACHMENT_READ' : 'QUEUE_ATTACHMENT_WRITE';
            this.registry.host.logger.warn('Queued attachment persistence failed', { operation: 'session.instructions', stage,
                outcome: 'failure', sessionId, operationId, code, durationMs: Date.now() - started });
            throw queueError(code, `${stage}: ${error instanceof Error ? error.message : 'Attachment operation failed'}`);
        }
    }

    private async recover(id: string, item: SessionInstruction): Promise<'running' | 'completed' | 'failed' | 'uncertain'> {
        if (this.runs.isActive(id) || !await this.ready(id)) return 'running';
        const raw = await this.registry.engine.readDocument(id, `round-${item.id}.json`);
        if (!raw) return 'uncertain';
        const round = JSON.parse(raw) as PersistedRound;
        if (round.sessionId !== id || round.id !== item.id) return 'uncertain';
        if (round.status === 'completed') return 'completed';
        if (round.status === 'failed' || round.status === 'cancelled') return 'failed';
        return 'uncertain';
    }
}
