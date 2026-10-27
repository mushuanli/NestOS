import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { findCycles } from '@itookit/llm-flow';
import { expandWorkflow } from './expand';
import { workflowSchema } from './schema';
import type { TaskConfig, CompiledWorkflow, RouteCondition, WorkflowConfigV1, WorkflowTaskSpec } from './types';

const TEMPLATE = /^\$\{tasks\.([^.}]+)\.outputs\.([^.}]+)\}$/;

export async function loadWorkflow(configPath: string, checkEnvironment = true): Promise<{
    workflow: CompiledWorkflow;
    source: string;
    hash: string;
}> {
    const absoluteConfig = path.resolve(configPath);
    const source = await readFile(absoluteConfig, 'utf8');
    const raw = parse(source) as unknown;
    const config = validateWorkflow(expandWorkflow(raw), checkEnvironment);
    const base = path.dirname(absoluteConfig);
    const workspaceRoot = config.workspace?.root === undefined ? process.cwd() : path.resolve(base, config.workspace.root);
    const stateDir = path.resolve(workspaceRoot, config.workspace?.state_dir ?? '.nestos');
    if (!isInside(workspaceRoot, stateDir)) throw new Error('workspace.state_dir must be inside workspace.root');
    if (stateDir === workspaceRoot) throw new Error('workspace.state_dir cannot equal workspace.root');
    return {
        workflow: {
            config,
            workspaceRoot,
            stateDir,
            maxDurationMs: parseDuration(config.runtime?.max_duration),
        },
        source,
        hash: createHash('sha256').update(source).digest('hex'),
    };
}

export function validateWorkflow(value: unknown, checkEnvironment = true): WorkflowConfigV1 {
    const config = parseWorkflow(value);
    const errors: string[] = [];
    validateUniqueIds(config, errors);
    validateRouteConditions(config, errors);
    validateReferences(config, errors);
    validateDag(config, errors);
    validateWorkspacePolicy(config, errors);
    if (checkEnvironment) validateEnvironment(config, errors);
    if (errors.length) throw new Error(errors.join('\n'));
    return config;
}

/** Run-level workspace policy: only what this host can actually honor is accepted. */
function validateWorkspacePolicy(config: WorkflowConfigV1, errors: string[]): void {
    const mode = config.runtime?.workspace?.mode;
    if (!mode || mode === 'shared') return;
    if (mode === 'read-only') {
        if ((config.sandbox?.mode ?? 'oci') !== 'oci') errors.push('runtime.workspace.mode read-only requires sandbox.mode: oci');
        if (config.runtime?.workspace?.merge && config.runtime.workspace.merge !== 'discard') errors.push('read-only workspaces cannot merge changes');
        return;
    }
    // The OCI sandbox only mounts the workspace root, so an isolated worktree prepared
    // outside it would be invisible to the agent's shell; require native sandbox instead
    // of silently running the node in the wrong directory.
    if ((config.sandbox?.mode ?? 'oci') !== 'native') {
        errors.push('runtime.workspace.mode worktree requires sandbox.mode: native');
    }
}

function validateUniqueIds(config: WorkflowConfigV1, errors: string[]): void {
    for (const key of ['providers', 'connections', 'agents', 'tasks'] as const) {
        const seen = new Set<string>();
        for (const item of config[key] ?? []) {
            if (seen.has(item.id)) errors.push(`${key} contains duplicate id ${item.id}`);
            seen.add(item.id);
        }
    }
}

function parseWorkflow(value: unknown): WorkflowConfigV1 {
    const result = workflowSchema.safeParse(value);
    if (!result.success) {
        throw new Error(result.error.issues.map(issue =>
            `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n'));
    }
    return result.data as unknown as WorkflowConfigV1;
}

function validateRouteConditions(config: WorkflowConfigV1, errors: string[]): void {
    for (const task of config.tasks ?? []) {
        for (const [index, rule] of (task.route?.rules ?? []).entries()) {
            validateRouteCondition(rule.when, `tasks.${task.id}.route.rules[${index}].when`, errors);
        }
    }
}

function validateEnvironment(config: WorkflowConfigV1, errors: string[]): void {
    for (const provider of config.providers ?? []) {
        if (provider.api_key_env && !process.env[provider.api_key_env]) {
            errors.push(`environment variable ${provider.api_key_env} is not set`);
        }
    }
}

function validateRouteCondition(condition: RouteCondition, label: string, errors: string[]): void {
    if (typeof condition === 'string') {
        if (!condition.trim()) errors.push(`${label} must not be empty`);
        return;
    }
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
        errors.push(`${label} must be a string or a condition object`);
        return;
    }
    const keys = ['eq', 'neq', 'in', 'exists', 'and', 'or', 'not'].filter(key => key in condition);
    if (!keys.length) errors.push(`${label} has no condition operator`);
    if (keys.length > 1) errors.push(`${label} must contain exactly one condition operator`);
    if (condition.path !== undefined
        && (!Array.isArray(condition.path) || condition.path.some(part => typeof part !== 'string'))) {
        errors.push(`${label}.path must be an array of strings`);
    }
    for (const list of ['and', 'or'] as const) {
        const sub = condition[list];
        if (sub !== undefined && !Array.isArray(sub)) errors.push(`${label}.${list} must be an array`);
        else (sub ?? []).forEach((item, index) => validateRouteCondition(item, `${label}.${list}[${index}]`, errors));
    }
    if (condition.not !== undefined) validateRouteCondition(condition.not, `${label}.not`, errors);
}

function validateReferences(config: WorkflowConfigV1, errors: string[]): void {
    const providers = ids(config.providers);
    const connections = ids(config.connections);
    const agents = ids(config.agents);
    const tasks = ids(config.tasks);
    for (const connection of config.connections ?? []) {
        if (!providers.has(connection.provider)) errors.push(`connection ${connection.id} references unknown provider ${connection.provider}`);
        validateConnectionModels(config, connection.id, errors);
    }
    for (const agent of config.agents ?? []) {
        if (!connections.has(agent.connection)) errors.push(`agent ${agent.id} references unknown connection ${agent.connection}`);
    }
    for (const task of config.tasks ?? []) {
        validateDelegationAgents(task, agents, errors);
        if (task.route !== undefined) {
            for (const rule of task.route.rules ?? []) {
                if (rule.then && !tasks.has(rule.then)) errors.push(`task ${task.id} route references unknown task ${rule.then}`);
            }
            if (task.route.default !== undefined && !tasks.has(task.route.default)) {
                errors.push(`task ${task.id} route default references unknown task ${task.route.default}`);
            }
        } else if (task.spawn !== undefined) {
            for (const subTask of task.spawn.tasks ?? []) {
                if (subTask.agent && !agents.has(subTask.agent)) {
                    errors.push(`task ${task.id} spawn references unknown agent ${subTask.agent}`);
                }
            }
            for (const edge of task.spawn.edges ?? []) {
                if (edge.from !== task.id && !tasks.has(edge.from)) {
                    errors.push(`task ${task.id} spawn edge references unknown task ${edge.from}`);
                }
                if (edge.to && !tasks.has(edge.to) && !task.spawn.tasks.some((sub: WorkflowTaskSpec) => sub.id === edge.to)) {
                    errors.push(`task ${task.id} spawn edge references unknown task ${edge.to}`);
                }
            }
        } else if (!task.node && !agents.has(task.agent ?? '')) {
            errors.push(`task ${task.id} references unknown agent ${task.agent}`);
        }
        if (task.compensate !== undefined && !tasks.has(task.compensate)) {
            errors.push(`task ${task.id} compensates unknown task ${task.compensate}`);
        }
        for (const worker of task.supervisor?.workers ?? []) {
            if (!tasks.has(worker)) errors.push(`task ${task.id} supervisor references unknown worker ${worker}`);
        }
        for (const dependency of task.depends_on ?? []) {
            const depId = typeof dependency === 'string' ? dependency : dependency.task;
            if (!tasks.has(depId)) errors.push(`task ${task.id} references unknown dependency ${depId}`);
            if (typeof dependency !== 'string' && dependency.on_failure !== undefined
                && !['fail', 'skip', 'continue'].includes(dependency.on_failure)) {
                errors.push(`task ${task.id} dependency ${depId} has invalid on_failure`);
            }
        }
        for (const [input, value] of Object.entries(task.inputs ?? {})) {
            if (typeof value !== 'string' || !value.startsWith('${tasks.')) continue;
            const match = TEMPLATE.exec(value);
            if (!match) errors.push(`task ${task.id} input ${input} has an invalid task output template`);
            else if (!tasks.has(match[1])) errors.push(`task ${task.id} input ${input} references unknown task ${match[1]}`);
            else validateOutputReference(config, task.id, input, match[1], match[2], errors);
        }
    }
    if (!config.result || !tasks.has(config.result.task)) errors.push('result.task must reference a task');
    const resultTask = config.tasks?.find(task => task.id === config.result?.task);
    if (resultTask?.outputs && !(config.result.output in resultTask.outputs)) {
        errors.push(`result.output ${config.result.output} is not declared by task ${resultTask.id}`);
    }
}

function validateConnectionModels(config: WorkflowConfigV1, connectionId: string, errors: string[]): void {
    const connection = config.connections?.find(item => item.id === connectionId);
    if (!connection || !connection.tiers || typeof connection.tiers !== 'object') {
        errors.push(`connection ${connectionId} requires tiers`);
        return;
    }
    const provider = config.providers?.find(item => item.id === connection.provider);
    const models = new Set(provider?.models?.map(model => model.id) ?? []);
    for (const [tier, model] of Object.entries(connection.tiers)) {
        if (!['optimal', 'standard', 'fast'].includes(tier)) errors.push(`connection ${connectionId} has invalid tier ${tier}`);
        if (typeof model !== 'string' || !models.has(model)) {
            errors.push(`connection ${connectionId} tier ${tier} references unknown model ${String(model)}`);
        }
    }
}

function validateOutputReference(
    config: WorkflowConfigV1,
    taskId: string,
    input: string,
    sourceId: string,
    output: string,
    errors: string[],
): void {
    const source = config.tasks?.find(task => task.id === sourceId);
    if (source?.outputs && !(output in source.outputs)) {
        errors.push(`task ${taskId} input ${input} references undeclared output ${sourceId}.${output}`);
    }
}

function validateDag(config: WorkflowConfigV1, errors: string[]): void {
    const edges = new Map((config.tasks ?? []).map(task => [
        task.id,
        new Set((task.depends_on ?? []).map(dep => typeof dep === 'string' ? dep : dep.task)),
    ]));
    for (const task of config.tasks ?? []) {
        for (const value of Object.values(task.inputs ?? {})) {
            if (typeof value === 'string') {
                const match = TEMPLATE.exec(value);
                if (match) edges.get(task.id)?.add(match[1]);
            }
        }
    }
    const nodes = (config.tasks ?? []).map(task => ({ id: task.id }));
    const graphEdges = [...edges.entries()].flatMap(([taskId, deps]) =>
        [...deps].map(dep => ({ id: `${dep}->${taskId}`, from: dep, to: taskId })));
    if (findCycles(nodes, graphEdges).backEdges.size > 0) {
        errors.push('tasks contain a dependency cycle');
    }
}

function ids(items?: Array<{ id: string }>): Set<string> {
    return new Set((items ?? []).map(item => item.id));
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function parseDuration(value: string | number | undefined, label = 'duration', errors?: string[]): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value.trim()) : null;
    if (match) return Number(match[1]) * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2]]!);
    errors?.push(`${label} must be a positive number of milliseconds or use ms/s/m/h`);
    if (!errors) throw new Error(`${label} is invalid`);
    return undefined;
}

export function taskOutputReference(value: unknown): { taskId: string; output: string } | undefined {
    if (typeof value !== 'string') return undefined;
    const match = TEMPLATE.exec(value);
    return match ? { taskId: match[1], output: match[2] } : undefined;
}

function validateDelegationAgents(task: TaskConfig, agents: Set<string>, errors: string[]): void {
    if (task.delegation && !agents.has(task.delegation.agent)) {
        errors.push(`task ${task.id} delegation references unknown agent ${task.delegation.agent}`);
    }
    for (const child of task.spawn?.tasks ?? []) validateDelegationAgents(child as TaskConfig, agents, errors);
}
