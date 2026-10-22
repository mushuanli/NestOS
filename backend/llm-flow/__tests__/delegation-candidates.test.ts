import { expect, it } from 'vitest';
import type { DagNodeDefinition, FlowRevision } from '../src/contracts';
import { delegationPlan, materializeDelegation, subtaskToolDef, type DelegationRuntimeState } from '../src/flow/delegation-runtime';
import { validateFlowRevision } from '../src/flow/validation';

function parent(): DagNodeDefinition {
    return { id: 'host', name: 'Host', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {}, config: {
        delegation: { enabled: true, agents: [{ agentId: 'a', name: 'First', description: 'First specialty' }, { agentId: 'b', name: 'Second' }],
            template: {}, resolvedTemplate: {}, resolvedTemplates: {
                a: { plugin: 'builtin.agent', pluginVersion: '1.0.0', capabilities: ['Read'], config: { agentId: 'a', connectionId: 'a-model' } },
                b: { plugin: 'builtin.agent', pluginVersion: '1.0.0', capabilities: [], config: { agentId: 'b', connectionId: 'b-model' } },
            }, fanout: { maxTasks: 2 }, result: { targetNodeId: 'summary' } },
    } };
}
const output = (items: unknown[]) => ({ message: { content: JSON.stringify(items) } });

it('advertises admitted Agent IDs and per-batch limits in the generic delegation schema', () => {
    const tool = subtaskToolDef('delegate', undefined, parent().config);
    expect(tool.function!.parameters).toMatchObject({ properties: { items: { maxItems: 2, items: {
        properties: { agentId: { enum: ['a', 'b'] }, instruction: { type: 'string', minLength: 1 } },
        required: ['agentId', 'instruction'], additionalProperties: false,
    } } } });
    expect(JSON.stringify(tool)).toContain('First specialty');
});

it('materializes only the selected frozen template and gates the downstream result consumer', () => {
    const node = parent(), plan = delegationPlan(node, 'host#1', 1, 0, output([{ agentId: 'a', instruction: 'Find the answer', connectionId: 'attacker' }]))!;
    const state: DelegationRuntimeState = { nodes: [node], edges: [], edgeState: new Map(), depths: new Map(), groups: new Map(), groupByChild: new Map() };
    materializeDelegation(node, plan, state);
    expect(state.nodes).toHaveLength(2);
    expect(state.nodes[1]).toMatchObject({ capabilities: ['Read'], config: { agentId: 'a', connectionId: 'a-model' } });
    expect(state.edges.some(edge => edge.from === state.nodes[1].id && edge.to === 'summary' && edge.kind === 'data')).toBe(true);
});

it('admits a candidate catalog without an unused generic child template', () => {
    const node = parent(), config = node.config as any;
    delete config.delegation.template; delete config.delegation.resolvedTemplate;
    const plan = delegationPlan(node, 'host#1', 1, 0, output([{ agentId: 'a', instruction: 'Use the admitted member' }]))!;
    expect(plan.templates!.a).toMatchObject({ config: { agentId: 'a', connectionId: 'a-model' } });
});

it.each([
    { items: [{ agentId: 'other', instruction: 'Forbidden' }] },
    { items: [{ agentId: 'a', instruction: '' }] },
    { items: [{ agentId: 'a', instruction: 'one' }, { agentId: 'b', instruction: 'two' }, { agentId: 'a', instruction: 'three' }] },
])('rejects invalid declarations before materialization instead of truncating or replacing identity (%j)', ({ items }) => {
    expect(() => delegationPlan(parent(), 'host#1', 1, 0, output(items))).toThrow();
});

it('resolves result targets within the current nested Flow namespace', () => {
    const node = { ...parent(), id: 'child/host' };
    expect(delegationPlan(node, 'child/host#1', 1, 0, output([]))!.targetNodeId).toBe('child/summary');
});

it('rejects duplicated candidate IDs and missing result consumers in published definitions', () => {
    const node = parent(); (node.config as any).delegation.agents = [{ agentId: 'a' }, { agentId: 'a' }];
    const issues = validateFlowRevision({ id: 'flow', name: 'Flow', revision: 1, digest: '', createdAt: 0,
        nodes: [node], edges: [], parameters: [], connections: [] } as FlowRevision);
    expect(issues.map(issue => issue.code)).toContain('invalid-delegation-agents');
    expect(issues.map(issue => issue.code)).toContain('invalid-delegation-target');
});
