import { bindCapabilities, type CapabilityBinding, type SessionHandle, type TaskHandle } from '@itookit/durable-kernel';

export async function bindFlowTaskCapabilities(session: SessionHandle, task: TaskHandle, programKind: string,
    toolIds: string[], budget?: Record<string, number>): Promise<void> {
    if (programKind !== 'llm.agent' && programKind !== 'llm.chat') return;
    await bindCapabilities(task, [
        { kind: 'llm', uri: 'llm://flow', rights: ['execute', 'admin'], signalKey: 'llmHandleId' },
        ...(toolIds.length ? [{ kind: 'tool', uri: 'tool://flow', rights: ['execute'], signalKey: 'toolHandleId' } satisfies CapabilityBinding] : []),
    ], async (binding, handleId) => {
        if (binding.kind === 'llm') for (const [dimension, limit] of Object.entries(budget ?? {})) {
            await session.setBudget(handleId, dimension, limit);
        }
    });
}
