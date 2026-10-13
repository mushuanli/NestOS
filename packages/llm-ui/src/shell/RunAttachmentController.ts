import type {
    EventEnvelope,
    InteractionRequest,
    JsonValue,
    TaskRecord,
    TaskSignal,
} from '@itookit/durable-kernel';
import { randomUUID } from '@itookit/common';

import type { AttachedTask, TaskControlPlane } from '@itookit/durable-kernel';
export type { AttachedTask, TaskControlPlane } from '@itookit/durable-kernel';

export interface RunAttachmentCallbacks {
    onEvent(event: EventEnvelope): void;
    onWaiting(request: InteractionRequest<JsonValue>): void;
    onError?(error: Error): void;
    onDetached?(taskId: string): void;
}

export class RunAttachmentController {
    private handle?: AttachedTask;
    private iterator?: AsyncIterator<EventEnvelope>;
    private generation = 0;

    constructor(
        private readonly controlPlane: TaskControlPlane,
        private readonly callbacks: RunAttachmentCallbacks,
    ) {}

    get activeTaskId(): string | undefined { return this.handle?.id; }

    /** Terminal outcomes (stdout, failure reason) belong to the host; the controller only exposes them. */
    async current(): Promise<TaskRecord | undefined> {
        if (!this.handle) return undefined;
        return (await this.handle.status()).task;
    }

    /** Changes synchronously whenever an attachment is replaced or detached. */
    get revision(): number { return this.generation; }

    async attach(taskId: string): Promise<void> {
        const detached = this.detach();
        const generation = this.generation;
        await detached;
        if (generation !== this.generation) return;
        const handle = await this.controlPlane.openTask(taskId);
        if (generation !== this.generation) return;
        this.handle = handle;
        const events = handle.events()[Symbol.asyncIterator]();
        this.iterator = events;
        void this.consume(events, generation).catch(error => {
            if (generation === this.generation) this.callbacks.onError?.(toError(error));
        });
    }

    async signal(signal: TaskSignal): Promise<void> {
        if (!this.handle) throw new Error('No task is attached');
        await this.handle.signal(signal);
    }

    async cancel(): Promise<void> {
        if (!this.handle) throw new Error('No task is attached');
        await this.handle.cancel('Cancelled by privileged command');
    }

    async resume(): Promise<void> {
        const handle = this.requireHandle();
        const { task } = await handle.status();
        if (task.control && task.control.mode !== 'run') {
            await handle.resume({ requestId: randomUUID(), expectedEpoch: task.control.epoch });
            return;
        }
        if (task.status === 'created') return handle.start();
        if (task.status === 'ready' || task.status === 'running') return;
        if (task.status === 'waiting' && acceptsSignal(task.wait, 'resume')) {
            return handle.signal({ type: 'resume' });
        }
        if (task.status === 'waiting') throw new Error('Task is waiting for an effect or approval');
        throw new Error(`Task cannot be resumed from ${task.status}`);
    }

    async pause(): Promise<void> {
        const handle = this.requireHandle();
        const { task } = await handle.status();
        await handle.pause({ requestId: randomUUID(), expectedEpoch: task.control?.epoch ?? 0 });
    }

    async interrupt(reason?: string): Promise<void> {
        const handle = this.requireHandle();
        const { task } = await handle.status();
        await handle.interrupt({ requestId: randomUUID(), expectedEpoch: task.control?.epoch ?? 0, reason });
    }

    async respondInput(interactionId: string, value: JsonValue, expectedRevision: number): Promise<void> {
        await this.respondInteraction(interactionId, 'input', value, expectedRevision);
    }

    async respondApproval(interactionId: string, approved: boolean, note: string, expectedRevision: number): Promise<void> {
        await this.respondInteraction(interactionId, 'approval', {
            approved, ...(note.trim() ? { note: note.trim() } : {}),
        }, expectedRevision);
    }

    private async respondInteraction(interactionId: string, kind: 'input' | 'approval', value: JsonValue, expectedRevision: number): Promise<void> {
        const handle = this.requireHandle();
        const task = (await handle.status()).task;
        if (this.generation !== expectedRevision || handle !== this.handle) throw new Error('Task attachment changed');
        const interaction = task.interactions[interactionId];
        if (isTerminal(task.status) || !interaction || interaction.status !== 'pending' || interaction.kind !== kind) {
            throw new Error('Interaction is no longer pending');
        }
        await handle.respond({ interactionId, value });
    }

    async approve(note = ''): Promise<void> {
        const revision = this.generation;
        const handle = this.requireHandle();
        const { task } = await handle.status();
        if (revision !== this.generation || handle !== this.handle) throw new Error('Task attachment changed');
        const interaction = Object.values(task.interactions)
            .filter(item => item.status === 'pending' && item.kind === 'approval')
            .sort((left, right) => right.requestedAt - left.requestedAt)[0];
        if (!interaction) throw new Error('Attached task has no pending approval');
        await this.respondApproval(interaction.id, true, note, revision);
    }

    async detach(): Promise<void> {
        const taskId = this.handle?.id;
        this.generation++;
        void this.iterator?.return?.();
        this.iterator = undefined;
        this.handle = undefined;
        if (taskId) this.callbacks.onDetached?.(taskId);
    }

    private async consume(iterator: AsyncIterator<EventEnvelope>, generation: number): Promise<void> {
        while (generation === this.generation) {
            const result = await iterator.next();
            if (result.done || generation !== this.generation) return;
            this.callbacks.onEvent(result.value);
            const request = interactionRequest(result.value);
            if (request) {
                const task = (await this.handle?.status())?.task;
                const pending = task?.interactions[request.id];
                if (generation === this.generation && task && !isTerminal(task.status) && pending?.status === 'pending') {
                    this.callbacks.onWaiting(pending);
                }
            }
        }
    }

    private requireHandle(): AttachedTask {
        if (!this.handle) throw new Error('No task is attached');
        return this.handle;
    }
}

function isTerminal(status: string): boolean {
    return ['succeeded', 'failed', 'cancelled'].includes(status);
}

function acceptsSignal(wait: import('@itookit/durable-kernel').WaitSpec | undefined, type: string): boolean {
    if (!wait) return false;
    if (wait.type === 'signal') return wait.id === undefined || wait.id === type;
    if (wait.type === 'any' || wait.type === 'all' || wait.type === 'quorum') {
        return wait.waits.some(item => acceptsSignal(item, type));
    }
    return false;
}

function interactionRequest(event: EventEnvelope): InteractionRequest<JsonValue> | undefined {
    return event.type === 'task.interaction.requested'
        ? event.payload as InteractionRequest<JsonValue>
        : undefined;
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
