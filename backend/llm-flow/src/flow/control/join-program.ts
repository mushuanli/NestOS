import type { DagNodeOutcome, FlowWaitPolicy, JsonValue } from '../../contracts';
import type { Decision, DurableTaskProgram, TaskInputEvent } from '@itookit/durable-kernel';
import { extractNodeOutput } from '@itookit/llm-tasks';

export interface JoinInput {
    policy: FlowWaitPolicy;
    dependencies: Array<{ taskId: string; nodeId: string; input: string; output?: string }>;
}
interface JoinState extends JoinInput {
    received: Record<string, { status: string; value: JsonValue; error: string | null }>;
    order: string[];
}
type Step = Decision<JoinState, DagNodeOutcome>;

export class FlowJoinProgram implements DurableTaskProgram<JoinState, JoinInput, DagNodeOutcome> {
    readonly manifest = { kind: 'flow.join', version: '1' };
    init(input: JoinInput): Step {
        validateWaitPolicy(input.policy, input.dependencies.length);
        if (new Set(input.dependencies.map(item => item.taskId)).size !== input.dependencies.length) throw new Error('Join dependencies must be unique');
        return wait({ ...structuredClone(input), received: {}, order: [] });
    }
    reduce(current: Readonly<JoinState>, event: TaskInputEvent): Step {
        const state = structuredClone(current);
        if (event.type !== 'task-exited') return wait(state);
        const dependency = state.dependencies.find(item => item.taskId === event.taskId);
        if (!dependency || state.received[event.taskId]) return wait(state);
        state.received[event.taskId] = { status: event.exit.status,
            value: (extractNodeOutput(event.exit.output, dependency.output ?? 'result') ?? null) as JsonValue,
            error: event.exit.error?.message ?? null };
        state.order.push(event.taskId);
        const successes = state.order.filter(id => state.received[id].status === 'succeeded');
        const required = state.policy.mode === 'all' ? state.dependencies.length : state.policy.mode === 'quorum' ? state.policy.quorum! : 1;
        const count = ['first-success', 'quorum'].includes(state.policy.mode) ? successes.length : state.order.length;
        if (count >= required) return complete(state);
        if (successes.length + state.dependencies.length - state.order.length < required && ['first-success', 'quorum'].includes(state.policy.mode)) {
            return { state, next: { type: 'fail', error: { code: 'JOIN_UNSATISFIED', message: `Join ${state.policy.mode} cannot be satisfied` } } };
        }
        return wait(state);
    }
}

export function validateWaitPolicy(policy: FlowWaitPolicy, count?: number): void {
    if (!['all', 'any', 'first-success', 'quorum'].includes(policy.mode)) throw new Error('Invalid join mode');
    if (policy.remaining && !['continue', 'cancel'].includes(policy.remaining)) throw new Error('Invalid remaining-task policy');
    if (policy.failure && !['fail', 'partial'].includes(policy.failure)) throw new Error('Invalid join failure policy');
    if (policy.result && !['collect', 'discard'].includes(policy.result)) throw new Error('Invalid join result policy');
    if (count === 0 || (policy.mode === 'quorum' && (!Number.isSafeInteger(policy.quorum) || policy.quorum! < 1 || count !== undefined && policy.quorum! > count))) throw new Error('Invalid join quorum/dependencies');
}

function wait(state: JoinState): Step {
    return { state, next: { type: 'wait', on: { type: 'any', waits: state.dependencies
        .filter(item => !state.received[item.taskId]).map(item => ({ type: 'task', id: item.taskId })) } } };
}

function complete(state: JoinState): Step {
    const failed = state.order.filter(id => state.received[id].status !== 'succeeded');
    if (failed.length && state.policy.failure !== 'partial' && ['all', 'any'].includes(state.policy.mode)) return { state, next: {
        type: 'fail', error: { code: 'JOIN_FAILED', message: state.received[failed[0]].error ?? 'Join dependency failed' } } };
    const selected = state.dependencies.filter(item => state.received[item.taskId]);
    const results = state.policy.result === 'discard' ? {} : Object.fromEntries(selected.filter(item => state.received[item.taskId].status === 'succeeded')
        .map(item => [item.input, state.received[item.taskId].value]));
    const failures = Object.fromEntries(selected.filter(item => state.received[item.taskId].status !== 'succeeded').map(item => [item.input, state.received[item.taskId].error ?? state.received[item.taskId].status]));
    const tasks = state.dependencies.filter(item => !state.received[item.taskId]).map(({ taskId, nodeId }) => ({ taskId, nodeId }));
    return { state, next: { type: 'complete', output: {
        outputs: { result: { outputName: 'result', content: { results, failures }, type: 'json' } },
        ...(state.policy.remaining === 'cancel' && tasks.length ? { effects: [{ type: 'cancel-tasks', tasks, reason: `Join ${state.policy.mode} satisfied` }] } : {}),
    } } };
}
