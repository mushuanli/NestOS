import { describe, expect, it } from 'vitest';
import type { FlowId, FlowNodeDefinition, FlowNodeId, FlowRevision } from '../src/contracts';
import { createBuiltinDagPluginRegistry } from '../src/flow/builtin-plugins';
import { validateFlowRevision } from '../src/flow/validation';

function revision(maxIterations: unknown): FlowRevision {
    const node: FlowNodeDefinition = {
        id: 'agent' as FlowNodeId,
        name: 'Agent',
        plugin: 'builtin.agent',
        pluginVersion: '1.0.0',
        config: { instruction: 'hi', approval: 'external', maxIterations },
        inputs: {},
    };
    return {
        id: 'f1' as FlowId,
        revision: 1,
        name: 'Test',
        nodes: [node],
        edges: [],
        parameters: [{ name: 'max_rounds', type: 'number', default: 2 }],
        createdAt: 0,
        digest: '',
    };
}

const plugins = createBuiltinDagPluginRegistry();

describe('validateFlowRevision schema checks', () => {
    it('accepts a ${params.x} placeholder for an integer field', () => {
        expect(validateFlowRevision(revision('${params.max_rounds}'), plugins)).toEqual([]);
    });

    it('accepts a literal integer', () => {
        expect(validateFlowRevision(revision(2), plugins)).toEqual([]);
    });

    it('rejects a non-placeholder string for an integer field', () => {
        const issues = validateFlowRevision(revision('abc'), plugins);
        expect(issues.some(issue =>
            issue.code === 'invalid-config' && issue.message.includes('maxIterations must be integer'),
        )).toBe(true);
    });

    it('accepts a bounded structured delegation', () => {
        const flow = revision(1);
        flow.nodes[0].config = {
            instruction: 'delegate',
            delegation: {
                enabled: true,
                toolName: 'delegate_tasks',
                template: { contextSource: 'parent', instruction: 'Do one item' },
                fanout: { maxTasks: 8, maxConcurrency: 4, maxDepth: 1, order: 'parallel' },
                failure: { policy: 'continue' },
            },
        };
        expect(validateFlowRevision(flow, plugins)).toEqual([]);
    });

    it('rejects unsafe delegation limits', () => {
        const flow = revision(1);
        flow.nodes[0].config = {
            delegation: { enabled: true, toolName: 'bad tool name', fanout: { maxTasks: 1000, maxDepth: 20 } },
        };
        const issues = validateFlowRevision(flow, plugins);
        expect(issues.some(issue => issue.code === 'invalid-delegation-tool')).toBe(true);
        expect(issues.filter(issue => issue.code === 'invalid-delegation-limit')).toHaveLength(2);
    });

    it('rejects invalid request limits and warns about legacy cost configuration', () => {
        const flow = revision(1);
        flow.nodes[0].config = {
            delegation: {
                enabled: true,
                failure: { policy: 'retry', maxAttempts: 99 },
                budget: { maxTokens: 0, timeoutMs: -1, maxCostUsd: 1 },
            },
        };
        const issues = validateFlowRevision(flow, plugins);

        expect(issues.some(issue => issue.code === 'invalid-delegation-retry')).toBe(true);
        expect(issues.filter(issue => issue.code === 'invalid-delegation-request-limit')).toHaveLength(2);
        expect(issues.some(issue => issue.code === 'unsupported-delegation-cost' && issue.severity === 'warning')).toBe(true);
    });
});
