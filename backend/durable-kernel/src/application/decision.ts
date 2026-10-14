// @file: durable-kernel/src/application/decision.ts
// 任务状态机：Decision 转移、重试、输入事件归一化、决策校验。

import type {
    Decision,
    DurableTaskProgram,
    KernelAction,
    RecoveryReport,
    SerializableError,
    TaskInputEvent,
    TaskRecord,
} from '../domain/types';
import { assertDurableValue } from './durability';
import { serializeError } from './effect-utils';

export async function nextDecision(program: DurableTaskProgram, task: TaskRecord): Promise<Decision> {
    const event = task.pendingEvents[0];
    if (!(task.initialized ?? task.state !== undefined)) return program.init(structuredClone(task.input));
    if (!event) return program.reduce(structuredClone(task.state) as never, { type: 'step' });
    return program.reduce(structuredClone(task.state) as never, normalizeInputEvent(structuredClone(event)));
}

export function normalizeInputEvent(event: TaskInputEvent): TaskInputEvent {
    // Business signals cannot forge broker result events.
    return event;
}

export function transition(task: TaskRecord, decision: Decision): TaskRecord {
    if (decision.next.type === 'complete') return terminal(task, 'succeeded', decision.next.output);
    if (decision.next.type === 'fail') {
        return shouldRetry(task, decision)
            ? retryTask(task, decision.next.error)
            : terminal(task, 'failed', undefined, decision.next.error);
    }
    if (decision.next.type === 'wait') {
        return { ...task, status: 'waiting', wait: decision.next.on, readyAt: undefined, currentAttempt: undefined };
    }
    return { ...task, status: 'ready', wait: undefined, readyAt: undefined, currentAttempt: undefined };
}

export function shouldRetry(task: TaskRecord, decision: Decision): boolean {
    return decision.next.type === 'fail' && decision.next.retryable === true
        && (task.stepAttemptCount ?? task.attemptCount) < task.retry.maxAttempts;
}

export function retryTask(
    task: TaskRecord,
    error: SerializableError,
): TaskRecord {
    return {
        ...task, status: 'ready', wait: undefined, exit: undefined, currentAttempt: undefined,
        readyAt: Date.now() + (task.retry.backoffMs ?? 0), lastError: error,
    };
}

export function terminal(
    task: TaskRecord,
    status: 'succeeded' | 'failed',
    output?: unknown,
    error?: SerializableError,
): TaskRecord {
    const completedAt = Date.now();
    return { ...task, status, output, wait: undefined, readyAt: undefined, currentAttempt: undefined,
        exit: { taskId: task.id, status, output, error, completedAt } };
}

export function failureDecision(state: unknown, error: unknown): Decision {
    return { state, next: { type: 'fail', error: serializeError(error), retryable: true } };
}

export function validateDecision(decision: Decision): void {
    if (decision.state !== undefined) assertDurableValue(decision.state, 'Task state');
    if (decision.next.type === 'complete' && decision.next.output !== undefined) {
        assertDurableValue(decision.next.output, 'Task output');
    }
    for (const action of decision.actions ?? []) validateAction(action);
}

export function validateAction(action: KernelAction): void {
    if (action.type === 'resource') assertDurableValue(action.command, 'Resource command');
    if (action.type === 'send-message') assertDurableValue(action.message.payload, 'Message payload');
    if (action.type === 'cache-publish') assertDurableValue(action.request.value, 'Cache value');
    if (action.type === 'spawn' && action.spec.input !== undefined) {
        assertDurableValue(action.spec.input, 'Spawn input');
    }
    if (action.type === 'set-shared') assertDurableValue(action.value, 'Shared state');
    if (action.type === 'emit' && action.payload !== undefined) {
        assertDurableValue(action.payload, 'Event payload');
    }
    if (action.type === 'request-interaction' && action.interaction.payload !== undefined) {
        assertDurableValue(action.interaction.payload, 'Interaction payload');
    }
}

export function mergeReport(target: RecoveryReport, value: RecoveryReport): void {
    target.recoveredTasks += value.recoveredTasks;
    target.recoveredEffects += value.recoveredEffects;
    target.expiredAttempts += value.expiredAttempts;
    target.rebuiltIndexes += value.rebuiltIndexes;
}

export function isTerminalStatus(status: TaskRecord['status']): boolean {
    return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
