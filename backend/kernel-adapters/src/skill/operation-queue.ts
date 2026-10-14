import { assertEffectGrant } from '@itookit/durable-kernel';
import type { EffectAdapter, EffectExecutionContext } from '@itookit/durable-kernel';
import type { SessionCapabilityRegistry } from '../ports/capabilities';

interface SessionQueue { tail?: Promise<unknown>; invalidated: boolean; }
interface RegistryQueue { closed: boolean; sessions: Map<string, SessionQueue>; }
const queues = new WeakMap<SessionCapabilityRegistry, RegistryQueue>();

function queueFor(registry: SessionCapabilityRegistry): RegistryQueue {
    let queue = queues.get(registry);
    if (!queue) { queue = { closed: false, sessions: new Map() }; queues.set(registry, queue); }
    return queue;
}

/** Serialize complete Skill mutations across host controls and Effects in this runtime. */
export function runSessionSkillOperation<T>(registry: SessionCapabilityRegistry, id: string, action: () => Promise<T>): Promise<T> {
    const owner = queueFor(registry);
    if (owner.closed) return Promise.reject(new Error('Session capability registry is closed'));
    let queue = owner.sessions.get(id);
    if (!queue) { queue = { invalidated: false }; owner.sessions.set(id, queue); }
    if (queue.invalidated) return Promise.reject(new Error('Session Skill operation scope changed'));
    const selected = queue;
    const next = (selected.tail ?? Promise.resolve()).catch(() => {}).then(() => {
        if (owner.closed || selected.invalidated) throw new Error('Session Skill operation scope changed');
        return action();
    });
    selected.tail = next;
    void next.finally(() => {
        if (!selected.invalidated && selected.tail === next && owner.sessions.get(id) === selected) owner.sessions.delete(id);
    }).catch(() => {});
    return next;
}

export function invalidateSessionSkillOperations(registry: SessionCapabilityRegistry, id: string): Promise<void> {
    const owner = queueFor(registry);
    const queue = owner.sessions.get(id) ?? { invalidated: false };
    queue.invalidated = true;
    owner.sessions.set(id, queue);
    return queue.tail?.then(() => {}, () => {}) ?? Promise.resolve();
}

export function reopenSessionSkillOperations(registry: SessionCapabilityRegistry, id: string): void {
    queueFor(registry).sessions.delete(id);
}

export function closeSessionSkillOperations(registry: SessionCapabilityRegistry): Promise<void> {
    const owner = queueFor(registry);
    owner.closed = true;
    for (const queue of owner.sessions.values()) queue.invalidated = true;
    const pending = [...owner.sessions.values()].map(queue => queue.tail);
    owner.sessions.clear();
    return Promise.allSettled(pending).then(() => {});
}

export function coordinateSkillEffect(effect: EffectAdapter, registry: SessionCapabilityRegistry): EffectAdapter {
    return {
        kind: effect.kind, version: effect.version, recoveryPolicy: effect.recoveryPolicy,
        cancel: effect.cancel?.bind(effect),
        shouldRetry: effect.shouldRetry?.bind(effect),
        execute: (request, context) => coordinate(effect.kind, registry, request, context, () => effect.execute(request, context)),
        reconcile: effect.reconcile ? (request, context) => coordinate(effect.kind, registry, request, context, () => effect.reconcile!(request, context)) : undefined,
    };
}

async function coordinate<T>(kind: string, registry: SessionCapabilityRegistry, request: unknown,
    context: EffectExecutionContext, action: () => Promise<T>): Promise<T> {
    let mutates = kind === 'skill.load' || kind === 'skill.unload';
    if (kind === 'tool.call') {
        assertEffectGrant(context, (request as { resourceHandleId: string }).resourceHandleId, 'tool');
        context.abortSignal.throwIfAborted();
        const scope = await (registry.getForEffect?.(context) ?? registry.get(context.sessionId));
        const meta = scope.toolService.getToolMeta((request as { toolId: string }).toolId);
        mutates = !!(meta?.skillLoaderArgKey || meta?.skillUnloaderArgKey);
    }
    return mutates ? runSessionSkillOperation(registry, context.sessionId, () => {
        context.abortSignal.throwIfAborted();
        return action();
    }) : action();
}
