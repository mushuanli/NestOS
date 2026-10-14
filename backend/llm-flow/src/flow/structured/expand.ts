import type { FlowDraft, FlowNodeDefinition, FlowEdgeDefinition, DispatchBranch } from '../../contracts';
import { object } from './value';

/** Editable expansion of legacy scopes; persistence changes only on an explicit save. */
export function expandDispatchDraft(draft: FlowDraft): FlowDraft {
    const result = structuredClone(draft);
    for (const node of draft.nodes) {
        const branches = object(node.config).branches as DispatchBranch[] | undefined;
        if (node.plugin !== 'builtin.route' || node.pluginVersion !== '2.0.0' || !branches?.length
            || branches.some(branch => branch.target.plugin !== 'builtin.agent' || branch.target.pluginVersion !== '1.0.0')) continue;
        expandScope(result, node, branches);
    }
    return result;
}
function expandScope(draft: FlowDraft, route: FlowNodeDefinition, branches: DispatchBranch[]): void {
    const { branches: _branches, until, maxRounds, revision, initialResults, join, ...routing } = object(route.config);
    const position = draft.layout.nodes?.[route.id] ?? { x: 320, y: 120 };
    const allocated = new Set(draft.nodes.map(node => String(node.id)));
    const allocate = (id: string) => nodeId(allocated, id);
    const aggregate = allocate(`${route.id}-aggregate`), judge = allocate(`${route.id}-judge`);
    const revisionInvocation = object(revision).invocation as DispatchBranch | undefined;
    const reviser = revisionInvocation ? { ...makeCheck(allocate, route, revisionInvocation), plugin: 'builtin.revise' } : undefined;
    if (reviser) reviser.config = { ...object(reviser.config), fields: object(revision).fields } as never;
    const checks = branches.map(branch => makeCheck(allocate, route, branch));
    const offset = draft.nodes.findIndex(node => node.id === route.id);
    draft.nodes[offset] = { ...route, name: '路由', pluginVersion: '3.0.0', config: routing as never };
    draft.nodes.push(...checks, ...(reviser ? [reviser] : []),
        { id: aggregate, name: '汇总检查结果', plugin: 'builtin.aggregate', pluginVersion: '2.0.0', inputs: {}, config: { strategy: 'latest', ...(join ? object(join) : {}), ...(initialResults ? { initialResults } : {}) } as never },
        { id: judge, name: '判断是否结束', plugin: 'builtin.judge', pluginVersion: '1.0.0', inputs: {}, outputPolicy: route.outputPolicy,
            config: { until, maxRounds, ...(revision && !reviser ? { revision } : {}) } as never });
    draft.edges = draft.edges.map(edge => edge.from === route.id ? { ...edge, from: judge } : edge);
    for (const check of checks) draft.edges.push(edge(route.id, check.id), edge(check.id, aggregate));
    draft.edges.push(edge(aggregate, judge), { ...edge(judge, reviser?.id ?? route.id), kind: 'control', output: 'repeat' });
    if (reviser) draft.edges.push(edge(reviser.id, route.id));
    const positions = draft.layout.nodes ??= {};
    checks.forEach((check, index) => { positions[check.id] = { x: position.x + 320, y: index * 180 + 40 }; });
    if (reviser) positions[reviser.id] = { x: position.x + 960, y: 440 };
    positions[aggregate] = { x: position.x + 640, y: 220 }; positions[judge] = { x: position.x + 960, y: 220 };
    for (const item of draft.nodes) if (![route.id, aggregate, judge, ...checks.map(check => check.id)].includes(item.id)
        && (positions[item.id]?.x ?? 0) > position.x) positions[item.id] = { ...positions[item.id], x: position.x + 1280 };
    draft.layout.viewport = { x: 0, y: 0, zoom: 0.7 };
}
function makeCheck(allocate: (id: string) => FlowNodeDefinition['id'], route: FlowNodeDefinition, branch: DispatchBranch): FlowNodeDefinition {
    const config = object(branch.target.config);
    return { ...branch.target, assign: branch.assign, id: allocate(`${route.id}-${branch.key}`), plugin: 'builtin.check', config: {
        ...config, ...(Array.isArray(config.systemPrompt) ? { systemPrompt: config.systemPrompt.join('\n') } : {}), key: branch.key, bindings: branch.input,
        instruction: [config.instruction, branch.instruction].filter(Boolean).join('\n'),
        ...(branch.prompt !== undefined ? { prompt: branch.prompt } : {}), ...(branch.outputContract ? { outputContract: branch.outputContract } : {}),
        ...(branch.when ? { when: branch.when } : {}), ...(branch.context ? { context: branch.context } : {}),
        ...(branch.publishToHistory !== undefined ? { publishToHistory: branch.publishToHistory } : {}),
        ...(branch.output ? { output: branch.output } : {}), ...(branch.outputFormat ? { outputFormat: branch.outputFormat } : {}),
        ...(branch.outputSchema ? { outputSchema: branch.outputSchema } : {}), ...(branch.validate ? { validate: branch.validate } : {}),
    } as never };
}
function nodeId(allocated: Set<string>, candidate: string): FlowNodeDefinition['id'] {
    let id = candidate, suffix = 0;
    while (allocated.has(id)) id = `${candidate}-${++suffix}`;
    allocated.add(id);
    return id as FlowNodeDefinition['id'];
}
function edge(from: FlowNodeDefinition['id'], to: FlowNodeDefinition['id']): FlowEdgeDefinition {
    return { id: `${from}--${to}` as FlowEdgeDefinition['id'], from, to, kind: 'data', output: 'result', input: 'input' };
}
