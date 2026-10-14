import type { EffectExecutionContext } from '@itookit/durable-kernel';

type ExecutionIdentity = Pick<EffectExecutionContext, 'sessionId' | 'taskId' | 'effectId'>;

/** Wait for local executions to settle before confirming adapter cancellation. */
export class InFlightEffects {
    private readonly executions = new Map<string, Set<Promise<unknown>>>();

    track<T>(identity: ExecutionIdentity, execution: Promise<T>): Promise<T> {
        const key = executionKey(identity);
        const pending = this.executions.get(key) ?? new Set<Promise<unknown>>();
        pending.add(execution);
        this.executions.set(key, pending);
        const clear = (): void => {
            pending.delete(execution);
            if (!pending.size && this.executions.get(key) === pending) this.executions.delete(key);
        };
        void execution.then(clear, clear);
        return execution;
    }

    /** Effect ids are Task-local; cancellation must never join another Task or Session. */
    async confirmStopped(identity: ExecutionIdentity): Promise<void> {
        const key = executionKey(identity);
        while (this.executions.has(key)) {
            await Promise.allSettled([...this.executions.get(key)!]);
        }
    }
}

function executionKey(identity: ExecutionIdentity): string {
    return JSON.stringify([identity.sessionId, identity.taskId, identity.effectId]);
}
