import type { DagNodeOutcome, JsonValue, SerializableExpression } from '../contracts';
import { mergeResults } from './structured/results';
import { scopeSpawn } from './spawn-scope';
import { evaluateFlowExpression as evaluate } from '../contracts/flow-expressions';
export { evaluateFlowExpression as evaluate, resolveFlowExpression as resolve } from '../contracts/flow-expressions';

export function aggregateOutcome(_config: Record<string, unknown>, inputs: Record<string, unknown>): DagNodeOutcome {
    // Dependency bindings already extract artifact content; keys belong to the caller.
    const previous = inputs.previous ?? {};
    const updates = inputs.updates ?? {};
    if (!isRecord(previous) || !isRecord(updates)) throw new Error('Aggregate inputs must be keyed objects');
    return outcome({ type: 'json' }, mergeResults(previous, updates));
}

export function transformOutcome(
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
): DagNodeOutcome {
    const source = config.value ?? firstInput(inputs)
        ?? (config.operation === 'batch' && Array.isArray(config.groups) ? config.groups.flat() : null);
    const content = config.operation === 'batch' ? batchValue(source, config)
        : config.operation === 'pick' ? pick(source, stringArray(config.path)) : source;
    return outcome(config, content);
}

/** Partition arbitrary input values into named argument sets without interpreting their contents. */
function batchValue(source: unknown, config: Record<string, unknown>): unknown[] {
    if (!Array.isArray(source)) throw new Error('Flow batch input must be an array');
    const size = config.batchSize ?? 1, parameter = config.parameter ?? 'items';
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) throw new Error('Flow batchSize must be a positive integer');
    if (typeof parameter !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(parameter)
        || ['__proto__', 'constructor', 'prototype'].includes(parameter)) throw new Error('Flow batch parameter must be a safe name');
    const groups = batchGroups(source, config);
    const batches = [];
    for (const group of groups) {
        for (let offset = 0; offset < group.length; offset += size) batches.push({ [parameter]: group.slice(offset, offset + size) });
    }
    return batches;
}

function batchGroups(source: unknown[], config: Record<string, unknown>): unknown[][] {
    const mode = config.mode ?? 'combined', groups = config.groups;
    if (mode !== 'combined' && mode !== 'grouped') throw new Error('Flow batch mode must be combined or grouped');
    if (groups === undefined) return [source];
    if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group) || group.length === 0)) {
        throw new Error('Flow batch groups must contain non-empty arrays');
    }
    if (groups.length === 0) return [source];
    if (JSON.stringify(groups.flat()) !== JSON.stringify(source)) {
        throw new Error('Flow batch groups must match input values and order exactly');
    }
    return mode === 'grouped' ? groups : [source];
}

/** 产出本节点的输出，并附带 patch-graph effect 动态添加节点/边。 */
export function spawnOutcome(
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
    parentId?: string,
): DagNodeOutcome {
    const base = transformOutcome(config, inputs);
    const spawn = config.scope === 'local' ? scopeSpawn(record(config.spawn), parentId) : record(config.spawn);
    const patch = {
        idempotencyKey: string(spawn.idempotencyKey, parentId ? `spawn:${parentId}` : 'spawn'),
        nodes: Array.isArray(spawn.nodes) ? spawn.nodes.filter(isRecord) : [],
        edges: Array.isArray(spawn.edges)
            ? spawn.edges.filter(isRecord).map(edge => ({
                ...(edge.id !== undefined ? { id: String(edge.id) } : {}),
                from: resolveSpawnEndpoint(edge.from, parentId),
                to: resolveSpawnEndpoint(edge.to, parentId),
                ...(edge.input !== undefined ? { input: String(edge.input) } : {}),
                ...(edge.output !== undefined ? { output: String(edge.output) } : {}),
                ...(edge.kind === 'control' || edge.kind === 'data' ? { kind: edge.kind } : {}),
                ...(edge.dependencyOnly === true ? { dependencyOnly: true } : {}),
                ...(edge.onFailure === 'fail' || edge.onFailure === 'skip' || edge.onFailure === 'continue'
                    ? { onFailure: edge.onFailure }
                    : {}),
            }))
            : [],
    };
    return { ...base, effects: [{ type: 'patch-graph' as const, patch: patch as never }] };
}

function resolveSpawnEndpoint(value: unknown, parentId?: string): string {
    const endpoint = String(value ?? '');
    if (endpoint === '$parent') return parentId ?? endpoint;
    if (endpoint.startsWith('$upstream:')) return endpoint.slice('$upstream:'.length);
    return endpoint;
}

export function reduceOutcome(
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
): DagNodeOutcome {
    const values = Object.values(inputs).flatMap(value => Array.isArray(value) ? value : [value])
        .map(artifactContent);
    const content = config.type === 'text'
        ? values.map(String).join(string(config.separator, '\n'))
        : values;
    return outcome(config, content);
}

export function routeOutcome(
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
    parameters?: Record<string, JsonValue>,
): DagNodeOutcome {
    const rules = Array.isArray(config.rules) ? config.rules.filter(isRecord) : [];
    const selected = selectEdges(rules, config, inputs, parameters);
    const defaultEdgeId = typeof config.defaultEdgeId === 'string' ? config.defaultEdgeId : '';
    // 待决定边 = 所有规则边 + 默认边；未选中的一律禁用（含默认边，当规则命中时）。
    const candidates = [...rules.map(rule => String(rule.edgeId ?? '')), defaultEdgeId].filter(Boolean);
    return {
        outputs: { result: { outputName: 'result', type: 'json', content: {
            selectedEdgeIds: selected, selectedValue: rules.find(rule => selected.includes(String(rule.edgeId))
                && evaluate((rule.expression ?? record(rule.condition).expression) as SerializableExpression, inputs, parameters))?.value as JsonValue ?? null,
        } } },
        effects: [
            ...selected.map(edgeId => ({ type: 'activate-edge' as const, edgeId: edgeId as never })),
            ...candidates.filter(id => !selected.includes(id))
                .map(edgeId => ({ type: 'disable-edge' as const, edgeId: edgeId as never })),
        ],
    };
}

function outcome(config: Record<string, unknown>, content: unknown): DagNodeOutcome {
    const outputName = string(config.outputName, 'result');
    return {
        outputs: {
            [outputName]: {
                outputName,
                type: string(config.type, 'json') as 'text' | 'json',
                content: cloneJson(content),
            },
        },
    };
}

function selectEdges(
    rules: Record<string, unknown>[],
    config: Record<string, unknown>,
    inputs: Record<string, unknown>,
    parameters?: Record<string, JsonValue>,
): string[] {
    const selected: string[] = [];
    for (const rule of rules.sort(compareRule)) {
        const expression = rule.expression ?? record(rule.condition).expression;
        if (!evaluate(expression as SerializableExpression, inputs, parameters)) continue;
        selected.push(String(rule.edgeId));
        if (config.mode !== 'multicast') break;
    }
    if (!selected.length && config.defaultEdgeId) selected.push(String(config.defaultEdgeId));
    return selected;
}

function firstInput(inputs: Record<string, unknown>): unknown {
    const value = Object.hasOwn(inputs, 'input') ? inputs.input : Object.values(inputs)[0];
    return artifactContent(value);
}

function artifactContent(value: unknown): unknown {
    return isRecord(value) && Object.hasOwn(value, 'content') ? value.content : value;
}

function pick(value: unknown, path: string[]): unknown {
    return artifactContent(readOwnPath(value, path, true));
}

function readOwnPath(value: unknown, path: string[], parseJson = false): unknown {
    let current = value;
    for (const part of path) {
        // Upstream JSON text is decoded only for input paths, never for parameter literals.
        if (parseJson && typeof current === 'string' && ['{', '['].includes(current.trim()[0])) {
            try { current = JSON.parse(current); } catch { /* keep the raw string */ }
        }
        if (Array.isArray(current)) {
            if (part === 'length') { current = current.length; continue; }
            if (!/^(?:0|[1-9]\d*)$/.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) >= current.length) return undefined;
        } else if (!isRecord(current)) return undefined;
        if (!Object.hasOwn(current, part)) return undefined;
        current = Array.isArray(current) ? current[Number(part)] : current[part];
    }
    return current;
}

function compareRule(left: Record<string, unknown>, right: Record<string, unknown>): number {
    return Number(left.priority ?? 0) - Number(right.priority ?? 0)
        || String(left.edgeId).localeCompare(String(right.edgeId));
}

function string(value: unknown, fallback: string): string { return typeof value === 'string' ? value : fallback; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.map(String) : []; }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function cloneJson(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value ?? null)) as JsonValue; }
