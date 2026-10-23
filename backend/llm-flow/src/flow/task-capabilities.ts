import { bindCapabilities, type CapabilityBinding, type SessionHandle, type TaskHandle } from '@itookit/durable-kernel';

export function flowTaskNeedsCapabilities(programKind: string): boolean {
    return ['llm.agent', 'llm.chat', 'kernel-adapters.media', 'kernel-adapters.tool', 'kernel-adapters.harness'].includes(programKind);
}

/** Reserved workers and retries use the same capability/start sequence. */
export async function startFlowTask(session: SessionHandle, task: TaskHandle, programKind: string,
    toolIds: string[], budget?: Record<string, number>): Promise<void> {
    if (flowTaskNeedsCapabilities(programKind)) await bindFlowTaskCapabilities(session, task, programKind, toolIds, budget);
    else await task.start();
}

export async function bindFlowTaskCapabilities(session: SessionHandle, task: TaskHandle, programKind: string,
    toolIds: string[], budget?: Record<string, number>): Promise<void> {
    const direct = programKind === 'kernel-adapters.tool';
    if (!flowTaskNeedsCapabilities(programKind)) return;
    if (programKind === 'kernel-adapters.harness') {
        await bindCapabilities(task, [{ kind: 'harness', uri: 'harness://flow', rights: ['execute'], signalKey: 'harnessHandleId' }]);
        return;
    }
    await bindCapabilities(task, [
        ...(!direct ? [{ kind: 'llm', uri: 'llm://flow', rights: ['execute', 'admin'], signalKey: 'llmHandleId' } satisfies CapabilityBinding] : []),
        ...(programKind !== 'kernel-adapters.media' && toolIds.length ? [{ kind: 'tool', uri: 'tool://flow', rights: ['execute'], signalKey: 'toolHandleId' } satisfies CapabilityBinding] : []),
    ], async (binding, handleId) => {
        if (binding.kind === 'llm') for (const [dimension, limit] of Object.entries(budget ?? {})) {
            await session.setBudget(handleId, dimension, limit);
        }
    });
}
