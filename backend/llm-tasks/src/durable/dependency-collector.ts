// @file: llm-runtime/src/durable/dependency-collector.ts
// 依赖收集状态机：等待依赖 → 收集 task-exited → 判就绪。
// 供 flow 的 FlowValue/FlowHuman 与 durable 的 agent/chat Program 复用，
// 消除「collectDependency / dependenciesReady / dependencyWait」模板重复。

import type { JsonValue, TaskInputEvent } from '@itookit/durable-kernel';
import { dependencyOutput, mergeDependencyOutput } from './program-helpers';
import type { DurableDependencyBinding } from './types';

/** 把一个 task-exited 事件收集进 dependencyOutputs / resolvedDependencyIds（原地更新）。 */
export function collectDependency(
    bindings: DurableDependencyBinding[],
    outputs: Record<string, JsonValue>,
    resolvedIds: string[],
    event: TaskInputEvent,
    defaultOutput?: string,
): void {
    if (event.type !== 'task-exited') return;
    const binding = bindings.find(item => item.taskId === event.taskId);
    if (!binding || resolvedIds.includes(binding.taskId)) return;
    resolvedIds.push(binding.taskId);
    if (binding.injectOutput === false) return;
    const dependency = dependencyOutput(event, bindings, defaultOutput);
    if (dependency) {
        mergeDependencyOutput(outputs, dependency.key, dependency.value);
    }
}

/** 所有 binding 的 taskId 都已收集即就绪。 */
export function dependenciesReady(
    bindings: Array<{ taskId: string }>,
    resolvedIds: string[],
): boolean {
    return bindings.every(item => resolvedIds.includes(item.taskId));
}

/** 构建「等待所有依赖 task-exited」的 WaitSpec。 */
export function dependencyWait(bindings: Array<{ taskId: string }>): {
    type: 'wait';
    on: { type: 'all'; waits: Array<{ type: 'task'; id: string }> };
} {
    return {
        type: 'wait',
        on: { type: 'all', waits: bindings.map(item => ({ type: 'task', id: item.taskId })) },
    };
}
