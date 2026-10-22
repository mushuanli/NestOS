import type { Kernel } from '@itookit/durable-kernel';
import type { SessionInstructionQueue } from '../contracts/instruction-queue';
import type { InstructionQueueSessions } from '../persistence/instruction-queue-sessions';
import { InstructionQueueStore } from '../persistence/instruction-queue-store';
import type { SessionHost } from '../utils/host-ports';
import { SessionInstructionQueues, type InstructionQueuePorts } from './instruction-queue';
import { queueError } from './instruction-queue-rules';

export interface SessionInstructionContext extends Pick<InstructionQueuePorts,
    'assertWritable' | 'branch' | 'ready' | 'submit' | 'recover' | 'prepare' | 'capture' | 'previouslyAccepted' | 'changed'> {
    hasSession(sessionId: string): boolean;
    idle(sessionId: string): void;
}

/** One queue, serializer and projection owner for all Session views in a host runtime. */
export class SessionInstructionRuntime {
    readonly queues: SessionInstructionQueues;
    private readonly contexts = new Set<SessionInstructionContext>();
    private readonly projections = new Map<string, SessionInstructionQueue>();
    private readonly release: () => void;
    private disposal?: Promise<void>;

    constructor(kernel: Kernel, private readonly host: SessionHost, sessions?: InstructionQueueSessions) {
        this.queues = new SessionInstructionQueues({
            store: new InstructionQueueStore(kernel), host,
            assertWritable: id => this.context(id).assertWritable(id),
            branch: id => this.context(id).branch(id),
            ready: id => this.find(id)?.ready(id) ?? Promise.resolve(false),
            submit: (id, item) => this.context(id).submit(id, item),
            recover: (id, item) => this.context(id).recover(id, item),
            prepare: (id, item, immediate) => this.context(id).prepare?.(id, item, immediate) ?? Promise.resolve(item),
            capture: (id, item, source) => this.context(id).capture?.(id, item, source) ?? Promise.resolve(item),
            previouslyAccepted: (id, item, digest) => this.context(id).previouslyAccepted?.(id, item, digest) ?? Promise.resolve(false),
            mark: id => sessions?.mark(id) ?? Promise.resolve(), unmark: id => sessions?.unmark(id) ?? Promise.resolve(),
            changed: queue => this.changed(queue), idle: id => this.notify(id, context => context.idle(id)),
        });
        this.release = kernel.onChanged(event => {
            if (event.reason === 'structure') this.queues.wake(event.sessionId);
        });
    }

    attach(context: SessionInstructionContext): () => void {
        this.contexts.add(context);
        return () => { this.contexts.delete(context); };
    }

    snapshot(id: string): SessionInstructionQueue | undefined {
        const queue = this.projections.get(id);
        return queue && structuredClone(queue);
    }

    hasPending(owns: (sessionId: string) => boolean): boolean {
        return this.queues.hasWork(owns)
            || [...this.projections.values()].some(queue => owns(queue.sessionId) && !queue.paused && queue.items.length > 0);
    }

    dispose(): Promise<void> {
        return this.disposal ??= (async () => {
            this.release(); this.queues.dispose(); await this.queues.whenIdle();
            this.contexts.clear(); this.projections.clear();
        })();
    }

    private find(id: string): SessionInstructionContext | undefined {
        return [...this.contexts].find(context => context.hasSession(id));
    }

    private context(id: string): SessionInstructionContext {
        const context = this.find(id);
        if (!context) throw queueError('QUEUE_SESSION_MISSING', 'Session execution context is unavailable');
        return context;
    }

    private changed(queue: SessionInstructionQueue): void {
        this.projections.set(queue.sessionId, structuredClone(queue));
        this.notify(queue.sessionId, context => context.changed(structuredClone(queue)));
    }

    private notify(sessionId: string, notify: (context: SessionInstructionContext) => void): void {
        for (const context of this.contexts) {
            if (!context.hasSession(sessionId)) continue;
            const started = Date.now();
            try { notify(context); }
            catch {
                this.host.logger.warn('Instruction queue observer failed', { operation: 'session.instructions', stage: 'observe',
                    outcome: 'failure', code: 'QUEUE_OBSERVER_FAILED', sessionId, operationId: sessionId, durationMs: Date.now() - started });
            }
        }
    }
}
