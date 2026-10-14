// @file: llm-flow/src/flow/delegation-runtime.ts
// Dynamic delegation runtime: parses a parent Agent's delegation declaration,
// materializes a bounded child group (fan-out / join / failure / budget), and
// injects the declarative subtask tool. DelegationController handles group lifecycle;
// executor.ts owns scheduling, checkpoints, leases, and workspace finalization.

import type { DagEdgeDefinition, DagNodeDefinition, JsonValue } from '../contracts';
import type { ToolDefinition } from '@itookit/llm-context';
import { DELEGATION_DEFAULTS, DELEGATION_LIMITS } from '../contracts';

export type EdgeState = 'active' | 'inactive' | 'pending';
export type DelegationFailurePolicy = 'fail-fast' | 'continue' | 'retry';

export interface DelegationGroup {
    policy: DelegationFailurePolicy;
    children: Set<string>;
    completed: Set<string>;
    succeeded: Set<string>;
    waitMode: 'all' | 'any' | 'first-success' | 'quorum';
    remaining?: 'continue' | 'cancel';
    quorum: number;
    detached: boolean;
    deadline?: number;
    resultOrder: 'declared' | 'completion';
}

export interface DelegationPlan {
    groupId: string;
    parentId: string;
    parentIteration: number;
    template: Record<string, unknown>;
    payloads: unknown[];
    depth: number;
    concurrency: number;
    failurePolicy: DelegationFailurePolicy;
    failure: Record<string, unknown>;
    includeResults: boolean;
    resultOrder: DelegationGroup['resultOrder'];
    waitMode: DelegationGroup['waitMode'];
    remaining: 'continue' | 'cancel';
    quorum: number;
    detached: boolean;
    waitTimeoutMs?: number;
    budget: Record<string, unknown>;
}

export interface DelegationRuntimeState {
    nodes: DagNodeDefinition[];
    edges: DagEdgeDefinition[];
    edgeState: Map<string, EdgeState>;
    depths: Map<string, number>;
    groups: Map<string, DelegationGroup>;
    groupByChild: Map<string, string>;
}

/** Build a delegation plan from a completed node, or undefined when it does not delegate. */
export function delegationPlan(
    node: DagNodeDefinition,
    key: string,
    parentIteration: number,
    depth: number,
    output: unknown,
): DelegationPlan | undefined {
    const config = isRecord(node.config) ? node.config : {};
    const runtime = normalizeDelegation(config);
    if (!runtime) return undefined;
    const templateValue = runtime.delegation.resolvedTemplate ?? runtime.template;
    if (!isRecord(templateValue)) return undefined;
    const fanout = delegationFanout(runtime.delegation, runtime.legacyMax);
    if (depth >= fanout.maxDepth) return undefined;
    const failure = isRecord(runtime.delegation.failure) ? runtime.delegation.failure : {};
    const failurePolicy = delegationFailurePolicy(failure);
    const join = isRecord(runtime.delegation.join) ? runtime.delegation.join : {};
    const wait = isRecord(runtime.delegation.wait) ? runtime.delegation.wait : {};
    const result = isRecord(runtime.delegation.result) ? runtime.delegation.result : {};
    const execution = isRecord(runtime.delegation.execution) ? runtime.delegation.execution : {};
    const waitMode = wait.mode === 'any' || wait.mode === 'first-success' || wait.mode === 'quorum'
        ? wait.mode : 'all';
    const payloads = parseSubtaskPayloads(output).slice(0, fanout.maxTasks);
    return {
        groupId: key,
        parentId: String(node.id),
        parentIteration,
        template: templateValue,
        payloads,
        depth,
        concurrency: fanout.concurrency,
        failurePolicy,
        failure,
        includeResults: result.mode ? result.mode !== 'discard' : join.mode !== 'none',
        resultOrder: result.order === 'completion' ? 'completion' : 'declared',
        waitMode,
        remaining: wait.remaining === 'continue' ? 'continue' : 'cancel',
        quorum: waitMode === 'quorum'
            ? Math.min(payloads.length, positiveInteger(wait.quorum) ?? payloads.length)
            : waitMode === 'all' ? payloads.length : 1,
        detached: execution.mode === 'detached',
        waitTimeoutMs: positiveInteger(wait.timeoutMs),
        budget: isRecord(runtime.delegation.budget) ? runtime.delegation.budget : {},
    };
}

/** Materialize the child group (nodes + edges) for a delegation plan. */
export function materializeDelegation(
    parent: DagNodeDefinition,
    plan: DelegationPlan,
    state: DelegationRuntimeState,
): void {
    const group: DelegationGroup = {
        policy: plan.failurePolicy,
        children: new Set(),
        completed: new Set(),
        succeeded: new Set(),
        waitMode: plan.waitMode,
        remaining: plan.remaining,
        quorum: plan.quorum,
        detached: plan.detached,
        resultOrder: plan.resultOrder,
        ...(plan.waitTimeoutMs ? { deadline: Date.now() + plan.waitTimeoutMs } : {}),
    };
    state.groups.set(plan.groupId, group);
    const createdIds: string[] = [];
    plan.payloads.forEach((payload, index) => {
        const childId = delegatedNodeId(plan.parentId, plan.parentIteration, index);
        if (state.nodes.some(node => String(node.id) === childId)) return;
        state.nodes.push(delegatedNode(parent, plan, childId, payload, index));
        state.depths.set(childId, plan.depth + 1);
        state.groupByChild.set(childId, plan.groupId);
        group.children.add(childId);
        connectDelegatedNode(plan, childId, createdIds, state);
        createdIds.push(childId);
    });
}

/** Resolve the declared subtask tool name (delegation, then legacy subtasks). */
export function subtaskToolName(config: unknown): string | undefined {
    if (!isRecord(config)) return undefined;
    const delegation = isRecord(config.delegation) ? config.delegation : undefined;
    if (delegation) {
        if (delegation.enabled !== true) return undefined;
        return typeof delegation.toolName === 'string' && delegation.toolName
            ? delegation.toolName : DELEGATION_DEFAULTS.toolName;
    }
    const subtasks = isRecord(config.subtasks) ? config.subtasks : undefined;
    return typeof subtasks?.tool === 'string' && subtasks.tool ? subtasks.tool : undefined;
}

export function subtaskToolDescription(config: unknown): string | undefined {
    if (!isRecord(config) || !isRecord(config.delegation)) return undefined;
    return typeof config.delegation.toolDescription === 'string' && config.delegation.toolDescription
        ? config.delegation.toolDescription
        : undefined;
}

/** ToolDefinition for the declarative subtask tool (call = declare sub-tasks). */
export function subtaskToolDef(name: string, description?: string): ToolDefinition {
    return {
        type: 'function',
        function: {
            name,
            description: description ?? 'Declare a bounded list of child tasks to execute',
            parameters: {
                type: 'object',
                properties: {
                    items: { type: 'array', items: { type: 'object' } },
                },
                required: ['items'],
            },
        },
    };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Convert deprecated `subtasks` once at the executor boundary. */
function normalizeDelegation(config: Record<string, unknown>): {
    delegation: Record<string, unknown>;
    template: unknown;
    legacyMax?: number;
} | undefined {
    if (isRecord(config.delegation)) {
        return config.delegation.enabled === true
            ? { delegation: config.delegation, template: config.delegation.template }
            : undefined;
    }
    if (!isRecord(config.subtasks)) return undefined;
    return {
        delegation: {},
        template: config.subtasks.template,
        legacyMax: positiveInteger(config.subtasks.max),
    };
}

function delegationFanout(delegation: Record<string, unknown>, legacyMax?: number): {
    maxTasks: number;
    maxDepth: number;
    concurrency: number;
} {
    const fanout = isRecord(delegation.fanout) ? delegation.fanout : {};
    const maxTasks = bounded(fanout.maxTasks, legacyMax ?? DELEGATION_DEFAULTS.maxTasks, DELEGATION_LIMITS.maxTasks);
    const maxDepth = bounded(fanout.maxDepth, DELEGATION_DEFAULTS.maxDepth, DELEGATION_LIMITS.maxDepth);
    const concurrency = fanout.order === 'sequential'
        ? 1
        : bounded(fanout.maxConcurrency, DELEGATION_DEFAULTS.maxConcurrency, DELEGATION_LIMITS.maxConcurrency);
    return { maxTasks, maxDepth, concurrency };
}

function delegationFailurePolicy(failure: Record<string, unknown>): DelegationFailurePolicy {
    return failure.policy === 'continue' || failure.policy === 'retry'
        ? failure.policy
        : DELEGATION_DEFAULTS.failurePolicy;
}

function delegatedNode(
    parent: DagNodeDefinition,
    plan: DelegationPlan,
    id: string,
    payload: unknown,
    index: number,
): DagNodeDefinition {
    const template = plan.template;
    const templateConfig = isRecord(template.config) ? template.config : template;
    return {
        id,
        name: `${parent.name} · 子任务${index + 1}`,
        plugin: typeof template.plugin === 'string' ? template.plugin : parent.plugin,
        pluginVersion: typeof template.pluginVersion === 'string' ? template.pluginVersion : parent.pluginVersion,
        config: delegatedConfig(templateConfig, plan, payload),
        inputs: { ...(isRecord(template.inputs) ? template.inputs : {}), payload: jsonValue(payload) },
        capabilities: Array.isArray(template.capabilities) ? template.capabilities.map(String) : [],
        retry: retryPolicy(plan.failurePolicy, plan.failure),
    };
}

function delegatedConfig(
    template: Record<string, unknown>,
    plan: DelegationPlan,
    payload: unknown,
): JsonValue {
    return jsonValue({
        ...template,
        ...(template.maxTokens === undefined && typeof plan.budget.maxTokens === 'number'
            ? { maxTokens: plan.budget.maxTokens } : {}),
        ...(template.timeoutMs === undefined && typeof plan.budget.timeoutMs === 'number'
            ? { timeoutMs: plan.budget.timeoutMs } : {}),
        messages: delegatedMessages(template, payload),
        persistOutput: plan.includeResults,
    });
}

function delegatedMessages(template: Record<string, unknown>, payload: unknown): unknown[] {
    if (Array.isArray(template.messages)) return [...template.messages, payloadMessage(payload)];
    const instruction = template.instruction ?? template.prompt;
    return [
        ...(typeof instruction === 'string' && instruction
            ? [{ role: 'system', content: instruction }] : []),
        payloadMessage(payload),
    ];
}

function retryPolicy(
    policy: DelegationFailurePolicy,
    failure: Record<string, unknown>,
): DagNodeDefinition['retry'] {
    if (policy !== 'retry') return undefined;
    return {
        maxAttempts: bounded(failure.maxAttempts, DELEGATION_DEFAULTS.retryAttempts, DELEGATION_LIMITS.retryAttempts),
        ...(positiveInteger(failure.backoffMs) ? { backoffMs: positiveInteger(failure.backoffMs) } : {}),
    };
}

function connectDelegatedNode(
    plan: DelegationPlan,
    childId: string,
    createdIds: string[],
    state: DelegationRuntimeState,
): void {
    activateEdge(state, {
        id: `${plan.parentId}->${childId}`,
        from: plan.parentId, to: childId, output: 'result', input: 'input',
        ...(plan.failurePolicy === 'continue' ? { onFailure: 'continue' as const } : {}),
    });
    if (createdIds.length < plan.concurrency) return;
    const predecessor = createdIds[createdIds.length - plan.concurrency];
    activateEdge(state, {
        id: `${predecessor}->${childId}:concurrency`,
        from: predecessor, to: childId, output: 'result', input: 'control', kind: 'control',
        ...(plan.failurePolicy === 'continue' ? { onFailure: 'continue' as const } : {}),
    });
}

function activateEdge(state: DelegationRuntimeState, edge: DagEdgeDefinition): void {
    state.edges.push(edge);
    state.edgeState.set(edge.id, 'active');
}

function delegatedNodeId(parentId: string, parentIteration: number, index: number): string {
    return `${parentId}:delegate:${parentIteration}:${index}`;
}

/** Parse an agent node's output content as a JSON array of subtask payloads. */
function parseSubtaskPayloads(output: unknown): unknown[] {
    const message = (output as { message?: { content?: unknown } } | undefined)?.message;
    const content = message?.content;
    if (typeof content !== 'string') return [];
    try {
        const parsed = JSON.parse(content);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function bounded(value: unknown, fallback: number, maximum: number): number {
    return Math.min(positiveInteger(value) ?? fallback, maximum);
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function payloadMessage(payload: unknown): { role: 'user'; content: string } {
    return { role: 'user', content: `Subtask payload:\n${typeof payload === 'string' ? payload : JSON.stringify(payload)}` };
}

function jsonValue(value: unknown): JsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
