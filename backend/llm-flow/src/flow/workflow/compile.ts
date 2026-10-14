// @file: llm-flow/src/flow/workflow/compile.ts
// 工作流 DSL → DagRunSpec 的图编译：depends_on/inputs 边、route/spawn/supervisor 展开、
// 循环与 Saga 补偿引用。agent 节点编译通过 agentFactory 注入，保持与入口解耦。

import type { DagEdgeDefinition, DagNodeDefinition } from '../../contracts';
import { compileRouteCondition } from './route-expression';
import type {
    AgentNodeFactory,
    OutputReferenceResolver,
    WorkflowGraph,
    WorkflowTaskSpec,
} from './types';

/** 把工作流任务列表编译成 DAG（节点 + 边）。 */
export function compileWorkflow(
    tasks: WorkflowTaskSpec[],
    agentFactory: AgentNodeFactory,
    resolveOutputReference?: OutputReferenceResolver,
): WorkflowGraph {
    // supervisor 的 worker 每次派发只执行一次，不随循环体重复。
    const supervisorWorkers = new Set<string>();
    for (const task of tasks) {
        for (const worker of task.supervisor?.workers ?? []) supervisorWorkers.add(worker);
    }

    const nodes: DagNodeDefinition[] = [];
    const extraEdges: DagEdgeDefinition[] = [];
    for (const task of tasks) {
        const kind = taskKind(task);
        if (kind === 'node') {
            if (!task.node) throw new Error(`Task ${task.id} requires a node definition`);
            nodes.push({ ...structuredClone(task.node), id: task.id, name: task.description ?? task.id,
                inputs: staticInputs(task, resolveOutputReference), priority: task.priority, budget: task.budget,
                ...(task.retry ? { retry: { maxAttempts: task.retry.max_attempts, backoffMs: task.retry.backoff_ms } } : {}) });
        } else if (kind === 'supervisor') {
            const sub = compileSupervisor(task, agentFactory);
            nodes.push(...sub.nodes);
            extraEdges.push(...sub.edges);
        } else if (kind === 'route') {
            nodes.push(compileRouteTask(task, resolveOutputReference));
        } else if (kind === 'spawn') {
            nodes.push(compileSpawnTask(task, agentFactory, resolveOutputReference));
        } else {
            const isWorker = supervisorWorkers.has(task.id);
            nodes.push(agentFactory(
                isWorker ? { ...task, max_iterations: 1 } : task,
                isWorker ? 'worker' : 'agent',
            ));
        }
    }

    return { nodes, edges: [...compileEdges(tasks, resolveOutputReference), ...extraEdges] };
}

/** 显式 kind 优先，否则按 route/spawn/supervisor 字段推断为对应控制节点。 */
function taskKind(task: WorkflowTaskSpec): 'agent' | 'route' | 'spawn' | 'supervisor' | 'node' {
    if (task.kind) return task.kind;
    if (task.node !== undefined) return 'node';
    if (task.supervisor !== undefined) return 'supervisor';
    if (task.route !== undefined) return 'route';
    if (task.spawn !== undefined) return 'spawn';
    return 'agent';
}

/** 把 supervisor 任务展开成「supervisor agent + route + worker 回边」循环子图。 */
function compileSupervisor(
    task: WorkflowTaskSpec,
    agentFactory: AgentNodeFactory,
): WorkflowGraph {
    const sup = task.supervisor!;
    const routerId = `${task.id}__router`;

    const lead = agentFactory({ ...task, max_iterations: sup.max_rounds ?? 10 }, 'supervisor');

    const router: DagNodeDefinition = {
        id: routerId,
        name: 'Supervisor Router',
        plugin: 'builtin.route',
        pluginVersion: '1.0.0',
        config: {
            mode: 'exclusive',
            rules: sup.workers.map(worker => ({
                edgeId: supEdgeId(task.id, worker),
                expression: { kind: 'eq', args: [{ kind: 'path', path: ['input'] }, { kind: 'literal', value: worker }] },
            })),
        },
        inputs: {},
        capabilities: [],
    };

    const edges: DagEdgeDefinition[] = [
        { id: `${task.id}->${routerId}`, from: task.id, to: routerId, output: 'result', input: 'input' },
        ...sup.workers.map(worker => ({
            id: supEdgeId(task.id, worker),
            from: routerId,
            to: worker,
            output: 'result',
            input: 'input',
        })),
        // worker → supervisor 回边（重新决策，构成循环）。
        ...sup.workers.map(worker => ({
            id: `${worker}->${task.id}`,
            from: worker,
            to: task.id,
            output: 'result',
            input: 'input',
        })),
    ];

    return { nodes: [lead, router], edges };
}

function supEdgeId(leadId: string, worker: string): string {
    return `${leadId}->${worker}`;
}

function compileSpawnTask(
    task: WorkflowTaskSpec,
    agentFactory: AgentNodeFactory,
    resolveOutputReference?: OutputReferenceResolver,
): DagNodeDefinition {
    const spawn = task.spawn!;
    return {
        id: task.id,
        name: task.description ?? task.id,
        plugin: 'builtin.spawn',
        pluginVersion: '1.0.0',
        config: {
            ...(task.description !== undefined ? { value: task.description } : {}),
            outputName: 'result',
            type: 'text',
            spawn: {
                nodes: spawn.tasks.map(subTask => agentFactory(subTask)),
                edges: spawn.edges.map(edge => ({
                    id: `${edge.from}->${edge.to}`,
                    from: edge.from,
                    to: edge.to,
                    ...(edge.input !== undefined ? { input: edge.input } : {}),
                    ...(edge.output !== undefined ? { output: edge.output } : {}),
                })),
            },
        },
        inputs: staticInputs(task, resolveOutputReference),
        capabilities: [],
    };
}

function compileRouteTask(
    task: WorkflowTaskSpec,
    resolveOutputReference?: OutputReferenceResolver,
): DagNodeDefinition {
    const route = task.route!;
    return {
        id: task.id,
        name: 'Route',
        plugin: 'builtin.route',
        pluginVersion: '1.0.0',
        config: {
            mode: route.mode ?? 'exclusive',
            rules: route.rules.map(rule => ({
                edgeId: routeEdgeId(task.id, rule.then),
                expression: compileRouteCondition(rule.when),
            })),
            ...(route.default !== undefined ? { defaultEdgeId: routeEdgeId(task.id, route.default) } : {}),
        },
        inputs: staticInputs(task, resolveOutputReference),
        capabilities: [],
    };
}

function compileEdges(
    tasks: WorkflowTaskSpec[],
    resolveOutputReference?: OutputReferenceResolver,
): DagEdgeDefinition[] {
    const edges = new Map<string, DagEdgeDefinition>();
    // route 分支目标 → route task 的映射，用于跳过目标 task 对 route 的 depends_on 依赖。
    const routeTargets = new Map<string, string>();
    for (const task of tasks) {
        if (task.route === undefined) continue;
        for (const rule of task.route.rules) {
            routeTargets.set(rule.then, task.id);
            addEdge(edges, task.id, rule.then, 'result', 'input', routeEdgeId(task.id, rule.then));
        }
        if (task.route.default !== undefined) {
            routeTargets.set(task.route.default, task.id);
            addEdge(edges, task.id, task.route.default, 'result', 'input', routeEdgeId(task.id, task.route.default));
        }
    }
    for (const task of tasks) {
        for (const [input, value] of Object.entries(task.inputs ?? {})) {
            const ref = resolveOutputReference?.(value);
            if (ref) addEdge(edges, ref.taskId, task.id, ref.output, input);
        }
        for (const dependency of task.depends_on ?? []) {
            const depId = typeof dependency === 'string' ? dependency : dependency.task;
            const onFailure = typeof dependency === 'string' ? undefined : dependency.on_failure;
            if (routeTargets.get(task.id) === depId) continue;
            const alreadyMapped = [...edges.values()].some(edge => edge.from === depId && edge.to === task.id);
            if (!alreadyMapped) addEdge(edges, depId, task.id, 'result', depId, undefined, onFailure);
        }
    }
    return [...edges.values()];
}

function staticInputs(
    task: WorkflowTaskSpec,
    resolveOutputReference?: OutputReferenceResolver,
): Record<string, unknown> {
    // 模板引用会编译成边，不应留在节点的静态 inputs 里。
    return Object.fromEntries(Object.entries(task.inputs ?? {})
        .filter(([, value]) => !resolveOutputReference?.(value)));
}

function addEdge(
    edges: Map<string, DagEdgeDefinition>,
    from: string,
    to: string,
    output: string,
    input: string,
    id?: string,
    onFailure?: 'fail' | 'skip' | 'continue',
): void {
    const edgeId = id ?? `${from}:${output}->${to}:${input}`;
    edges.set(edgeId, { id: edgeId, from, to, output, input, ...(onFailure ? { onFailure } : {}) });
}

function routeEdgeId(from: string, to: string): string {
    return `${from}->${to}`;
}
