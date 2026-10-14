// @file: durable-kernel/src/application/capabilities.ts
// 能力绑定：为 Task 创建类型化 ResourceHandle，signal capabilities 后启动。
// 统一上层（llm-conversation / kernel-adapters）反复实现的「createResource + signal + start」模板。

import type { ResourceRight, TaskHandle, TaskSignal } from '../domain/types';

export interface CapabilityBinding {
    kind: string;
    uri: string;
    rights: ResourceRight[];
    /** capabilities signal payload 里的键。 */
    signalKey: string;
}

/**
 * 为 task 创建能力资源（llm/tool/...），逐个回调 onHandle（用于 setBudget 等），
 * 然后以 { [signalKey]: handleId } 发出 capabilities signal 并启动任务。
 */
export async function bindCapabilities(
    task: TaskHandle,
    bindings: CapabilityBinding[],
    onHandle?: (binding: CapabilityBinding, handleId: string) => Promise<void>,
): Promise<void> {
    const payload: Record<string, string> = {};
    for (const binding of bindings) {
        const grant = await task.createResource({
            requestId: `capability:${binding.signalKey}`,
            kind: binding.kind,
            uri: binding.uri,
            rights: binding.rights,
        });
        payload[binding.signalKey] = grant.handle.id;
        await onHandle?.(binding, grant.handle.id);
    }
    const signal: TaskSignal = { type: 'capabilities', payload };
    await task.start({ signal });
}
