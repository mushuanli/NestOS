import type { JsonValue, SessionHandle, TaskHandle } from '@itookit/durable-kernel';
import type { DagNodeDefinition, FlowRunGoal } from '../contracts';
import type { FlowExecutionHandle } from './executor';
import type { DelegationGroup } from './delegation-runtime';
import type { SchedulerCheckpoint } from './scheduler-checkpoint';
import { variableCurrent } from './variables';

interface AggregationState {
    instances: Map<string, TaskHandle[]>;
    nodes: DagNodeDefinition[];
    detachedNodes: Set<string>;
    groups: Map<string, DelegationGroup>;
    completionOrder: string[];
}

interface AggregationRequest {
    goal?: FlowRunGoal;
    usage: FlowExecutionHandle['usage'];
    existing?: FlowExecutionHandle;
    awaitingSchedule?: boolean;
    toleratedFailures: Set<string>;
    initial?: Record<string, JsonValue>;
}

/** Persist the Run's root projection without driving node scheduling. */
export class FlowRunAggregation {
    constructor(private readonly session: SessionHandle, private readonly state: AggregationState) {}

    async finish(request: AggregationRequest): Promise<FlowExecutionHandle> {
        const root = await this.aggregate(request);
        const { instances, detachedNodes } = this.state;
        if (request.existing) {
            request.existing.usage = request.usage;
            request.existing.goal = request.goal;
            request.existing.detachedNodes = detachedNodes;
            return request.existing;
        }
        return {
            sessionId: this.session.id, root,
            nodes: new Map([...instances].map(([id, handles]) => [id, handles[handles.length - 1]])),
            iterations: new Map([...instances].map(([id, handles]) => [id, handles.length])),
            goal: request.goal, detachedNodes,
            taskIds: new Set([...instances.values()].flatMap(handles => handles.map(handle => handle.id)).concat(root.id)),
            usage: request.usage,
        };
    }

    private async aggregate(request: AggregationRequest): Promise<TaskHandle<JsonValue>> {
        const root = request.existing?.root;
        const checkpoint = root && !request.awaitingSchedule
            ? (await this.session.getShared(`flow.run.${root.id}.scheduler`))?.value as unknown as SchedulerCheckpoint : undefined;
        const dependencies = this.dependencies(request.toleratedFailures);
        const input = this.input(request, checkpoint, dependencies);
        if (root) {
            await this.session.setShared(`flow.run.${root.id}.members`, jsonValue(input.runTasks));
            await this.session.setShared(`flow.run.${root.id}.metadata`, input.run);
            await this.session.signal(root.id, { type: 'flow.schedule.completed', payload: jsonValue(input) });
            return root;
        }
        const initialCheckpoint = request.initial?.initialScheduler as unknown as SchedulerCheckpoint | undefined;
        return this.session.submit({
            program: { kind: 'flow.aggregate', version: '1' }, input,
            ...(initialCheckpoint?.spec.invocation ? { requestId: `flow-invocation:${initialCheckpoint.spec.invocation.requestId}` } : {}),
            // Terminal dependencies still decide success, including suppressed outputs.
            dependsOn: request.awaitingSchedule ? [] : dependencies.map(item => ({ task: item.taskId, condition: 'terminal' })),
            labels: { kind: 'flow-root' },
        });
    }

    private dependencies(toleratedFailures: Set<string>) {
        const state = this.state;
        const suppressed = new Set(state.nodes.filter(node => node.outputPolicy?.includeInRunOutput === false
            || (node.outputPolicy?.includeInRunOutput === undefined && record(node.config).persistOutput === false)).map(node => String(node.id)));
        return orderDelegationResults([...state.instances].filter(([id]) => !state.detachedNodes.has(id))
            .map(([nodeId, handles]) => ({ taskId: handles[handles.length - 1].id, nodeId,
                tolerated: toleratedFailures.has(nodeId), collectOutput: !suppressed.has(nodeId) })), state.groups, state.completionOrder);
    }

    private input(request: AggregationRequest, checkpoint: SchedulerCheckpoint | undefined,
        dependencies: ReturnType<FlowRunAggregation['dependencies']>) {
        const variables = checkpoint?.variables;
        return { ...request.initial,
            ...(variables && Object.keys(variables.initial).length ? { variables: jsonValue({ initial: variables.initial,
                changes: variables.commits, current: variableCurrent(variables) }) } : {}),
            dependencies, awaitingSchedule: request.awaitingSchedule ?? false,
            run: jsonValue({ version: 1, goal: request.goal ?? null, usage: request.usage }),
            runTasks: runMembers(this.state.instances, this.state.nodes, this.state.detachedNodes) };
    }
}

export function runMembers(instances: Map<string, TaskHandle[]>, nodes: DagNodeDefinition[], detached: Set<string>) {
    return [...instances].flatMap(([nodeId, handles]) => handles.map((handle, index) => ({
        nodeId, taskId: handle.id, iteration: index + 1, detached: detached.has(nodeId),
        budget: jsonValue(nodes.find(node => node.id === nodeId)?.budget ?? {}),
    })));
}

function orderDelegationResults<T extends { nodeId: string }>(values: T[], groups: Map<string, DelegationGroup>, completionOrder: string[]): T[] {
    const result = [...values];
    const rank = new Map(completionOrder.map((nodeId, index) => [nodeId, index]));
    for (const group of groups.values()) {
        if (group.resultOrder !== 'completion') continue;
        const positions = result.map((value, index) => group.children.has(value.nodeId) ? index : -1).filter(index => index >= 0);
        const ordered = positions.map(index => result[index])
            .sort((left, right) => (rank.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER));
        positions.forEach((position, index) => { result[position] = ordered[index]; });
    }
    return result;
}

function record(value: unknown): Record<string, JsonValue> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function jsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}
