import { describe, expect, it } from 'vitest';
import { expandWorkflow } from '../src/expand';
import { validateWorkflow } from '../src/config';
import type { WorkflowConfigV1 } from '../src/types';
import {compileWorkflow} from '@itookit/llm-flow';

describe('expandWorkflow', () => {
    it('orders tool dependencies without silently injecting them into arguments', () => {
        const value = expandWorkflow({version: 1, name: 'ordered', goal: 'Run tools', tasks: [
            {id: 'fetch', tool: 'fixture.fetch'}, {id: 'save', tool: 'fixture.save', needs: 'fetch'},
        ], result: 'save'});
        const config = validateWorkflow(value, false);
        const graph = compileWorkflow(config.tasks.map(task => ({...task})), () => {throw new Error('A tool workflow must not acquire an Agent');});
        expect(graph.edges).toEqual([expect.objectContaining({from: 'fetch', to: 'save', kind: 'control'})]);
    });
    it('composes MCP input, a configured Harness and a tool output without a local model', () => {
        const expanded = expandWorkflow({version: 1, name: 'remote-report', goal: 'Report', tasks: [
            {id: 'fetch', mcp: {server: 'knowledge', tool: 'search'}, args: {query: 'recent'}},
            {id: 'work', harness: 'reviewer', prompt: 'Summarize the supplied material', inputs: {input: '${tasks.fetch.outputs.result}'}},
            {id: 'save', tool: 'fixture.save', input_argument: 'body', inputs: {input: '${tasks.work.outputs.result}'}},
        ], result: 'save'});
        const config = validateWorkflow(expanded, false);
        expect(config.tasks[1].node).toMatchObject({plugin: 'builtin.agent', config: {
            execution: {kind: 'harness', connectionId: 'reviewer'}, messages: [{role: 'user', content: 'Summarize the supplied material'}]}});
        expect(config.tasks[2].node?.config).toMatchObject({inputArgument: 'body'});
    });
    it('expands Tool/MCP input and output steps without requiring a model', () => {
        const source = {version: 1, name: 'collect', goal: 'Collect material', tasks: [
            {id: 'fetch', kind: 'tool', mcp: {server: 'knowledge_base', tool: 'search'}, args: {query: 'recent'}},
            {id: 'save', tool: 'fixture.save', inputs: {input: '${tasks.fetch.outputs.result}'}, args: {format: 'json'}},
        ], result: 'save'};
        const expanded = expandWorkflow(source) as WorkflowConfigV1;
        const config = validateWorkflow(expanded, false);
        expect(config.agents).toEqual([]);
        expect(config.tasks[0].node).toMatchObject({plugin: 'builtin.tool',
            capabilities: ['mcp__knowledge_5Fbase__search'], config: {toolVersion: '1', approval: 'all'}});
        expect(config.tasks[1].inputs).toEqual({input: '${tasks.fetch.outputs.result}'});
        expect(source.tasks[0].kind).toBe('tool');
    });

    it.each([
        {tool: 'fixture', mcp: {server: 's', tool: 't'}},
        {tool: 'fixture', kind: 'agent'},
        {tool: 'fixture', agent: 'writer'},
        {mcp: {server: 's', tool: 't', command: 'untrusted'}},
        {tool: 'fixture', args: []},
        {tool: 'fixture', approval: 'invalid'},
    ])('rejects ambiguous or invalid tool shortcuts: %j', fields => {
        expect(() => expandWorkflow({tasks: [{id: 'fetch', ...fields}]})).toThrow();
    });
    it('expands model/env/prompt/needs shorthand into a full workflow', () => {
        const expanded = expandWorkflow({
            version: 1,
            name: 'x',
            goal: 'ship',
            model: 'anthropic/claude-sonnet',
            env: { api_key: 'ANTHROPIC_API_KEY' },
            tasks: [
                { id: 'inspect', prompt: '检查代码' },
                { id: 'report', needs: 'inspect', prompt: '报告' },
            ],
            result: 'report',
        }) as WorkflowConfigV1;

        expect(expanded.providers[0]).toMatchObject({
            id: 'default', implementation: 'anthropic', api_key_env: 'ANTHROPIC_API_KEY',
        });
        expect(expanded.agents[0]).toEqual({ id: 'default', connection: 'default' });
        expect(expanded.tasks[0]).toMatchObject({ id: 'inspect', agent: 'default', description: '检查代码', outputs: { result: 'text' } });
        expect(expanded.tasks[1]).toMatchObject({ id: 'report', depends_on: ['inspect'] });
        expect(expanded.result).toEqual({ task: 'report', output: 'result' });
        // 展开后的完整配置能通过校验。
        expect(validateWorkflow(expanded, false).name).toBe('x');
    });

    it('rejects an unknown provider without base_url', () => {
        expect(() => expandWorkflow({ model: 'foo/bar', env: { api_key: 'K' } })).toThrow('base_url');
    });

    it('rejects model shorthand without an api key env', () => {
        expect(() => expandWorkflow({ model: 'anthropic/claude' })).toThrow('api_key');
    });
});
