import { describe, expect, it } from 'vitest';
import { validateWorkflow } from '../src/config';
import type { WorkflowConfigV1 } from '../src/types';

function workflow(): WorkflowConfigV1 {
    return {
        version: 1,
        name: 'test',
        goal: 'ship',
        providers: [{
            id: 'provider', implementation: 'openai-compatible', base_url: 'http://localhost',
            api_key_env: 'TEST_API_KEY', models: [{ id: 'model' }],
        }],
        connections: [{ id: 'default', provider: 'provider', tiers: { standard: 'model' } }],
        agents: [{ id: 'agent', connection: 'default', tools: ['file_read'] }],
        tasks: [{ id: 'first', agent: 'agent', description: 'First', outputs: { result: 'text' } }],
        result: { task: 'first', output: 'result' },
    };
}

describe('validateWorkflow', () => {
    it('accepts versioned plugin nodes without an Agent reference', () => {
        const value = workflow();
        value.tasks = [{ id: 'collect', kind: 'node', node: { plugin: 'builtin.input', pluginVersion: '1.0.0',
            config: { fields: { text: { type: 'string' } } } }, outputs: { result: 'json' } }];
        value.result = { task: 'collect', output: 'result' };
        expect(validateWorkflow(value, false).tasks[0].node?.plugin).toBe('builtin.input');
    });
    it('validates explicit memory scope grants and retention limits', () => {
        const value = workflow();
        value.agents[0].memory_policy = { namespace_id: 'agent', read_scopes: ['project'], write_scopes: [],
            retention: { max_entries_per_scope: 10 }, retrieval_limit: 0 };
        expect(validateWorkflow(value, false).agents[0].memory_policy).toEqual(value.agents[0].memory_policy);
        value.agents[0].memory_policy.retention!.max_entries_per_scope = 0;
        expect(() => validateWorkflow(value, false)).toThrow('max_entries_per_scope');
    });
    it('validates bounded local delegation', () => {
        const value = workflow();
        value.tasks[0].delegation = { agent: 'agent', max_tasks: 2, max_concurrency: 1 };
        expect(validateWorkflow(value, false).tasks[0].delegation).toEqual(value.tasks[0].delegation);
        value.tasks[0].delegation.agent = 'missing';
        expect(() => validateWorkflow(value, false)).toThrow('unknown agent');
        value.tasks[0].delegation.agent = 'agent';
        value.tasks[0].delegation.max_tasks = 33;
        expect(() => validateWorkflow(value, false)).toThrow('max_tasks');
    });

    it('accepts explicit structured-output and node port contracts', () => {
        const value = workflow();
        value.agents[0].response_format = { type: 'json_schema', json_schema: { name: 'report', schema: { type: 'object' } } };
        value.tasks[0].port_schemas = { outputs: { result: { id: 'report', version: '1' } } };
        expect(validateWorkflow(value, false).tasks[0].port_schemas).toEqual(value.tasks[0].port_schemas);
        value.agents[0].output_validation = { on_invalid: 'repair', retries: -1 };
        expect(() => validateWorkflow(value, false)).toThrow('retries');
    });

    it('accepts a minimal workflow', () => {
        expect(validateWorkflow(workflow(), false).name).toBe('test');
    });

    it('rejects cyclic tasks', () => {
        const value = workflow();
        value.tasks = [
            { id: 'first', agent: 'agent', description: 'First', depends_on: ['second'], outputs: { result: 'text' } },
            { id: 'second', agent: 'agent', description: 'Second', depends_on: ['first'], outputs: { result: 'text' } },
        ];
        expect(() => validateWorkflow(value, false)).toThrow('dependency cycle');
    });

    it('rejects an unknown output reference', () => {
        const value = workflow();
        value.tasks.push({
            id: 'second', agent: 'agent', description: 'Second', depends_on: [], outputs: { result: 'text' },
            inputs: { source: '${tasks.missing.outputs.result}' },
        });
        expect(() => validateWorkflow(value, false)).toThrow('unknown task missing');
    });

    it('rejects invalid retries', () => {
        const value = workflow();
        value.tasks.push({
            id: 'second', agent: 'agent', description: 'Second', outputs: { result: 'text' },
            retry: { max_attempts: 0 },
        });
        expect(() => validateWorkflow(value, false)).toThrow('retry.max_attempts');
    });

    it('rejects undeclared outputs', () => {
        const value = workflow();
        value.tasks.push({
            id: 'second', agent: 'agent', description: 'Second', outputs: { result: 'text' },
            inputs: { source: '${tasks.first.outputs.missing}' },
        });
        expect(() => validateWorkflow(value, false)).toThrow('undeclared output first.missing');
    });

    it('rejects an invalid agent approval strategy', () => {
        const value = workflow();
        value.agents[0].approval = 'sometimes' as never;
        expect(() => validateWorkflow(value, false)).toThrow('approval');
    });

    it('rejects an invalid route mode', () => {
        const value = workflow();
        value.tasks.push({
            id: 'router', route: { mode: 'parallel' as never, rules: [{ when: 'x', then: 'first' }] },
            depends_on: [], inputs: { input: '${tasks.first.outputs.result}' },
        });
        expect(() => validateWorkflow(value, false)).toThrow('route.mode');
    });

    it('rejects an invalid on_failure value', () => {
        const value = workflow();
        value.tasks.push({
            id: 'second', agent: 'agent', description: 'Second',
            depends_on: [{ task: 'first', on_failure: 'retry' as never }], outputs: { result: 'text' },
        });
        expect(() => validateWorkflow(value, false)).toThrow('depends_on');
    });

    it('rejects a route condition with no operator', () => {
        const value = workflow();
        value.tasks.push({
            id: 'router', route: { rules: [{ when: {} as never, then: 'first' }] },
            depends_on: [], inputs: { input: '${tasks.first.outputs.result}' },
        });
        expect(() => validateWorkflow(value, false)).toThrow('no condition operator');
    });

    it('accepts a composite route condition', () => {
        const value = workflow();
        value.tasks.push({
            id: 'router',
            route: {
                rules: [{
                    when: { and: [{ in: ['a', 'b'] }, { not: 'c' }] },
                    then: 'first',
                }],
            },
            depends_on: [], inputs: { input: '${tasks.first.outputs.result}' },
        });
        expect(validateWorkflow(value, false).tasks).toHaveLength(2);
    });

    it('rejects a route condition with multiple operators', () => {
        const value = workflow();
        value.tasks.push({
            id: 'router',
            route: { rules: [{ when: { eq: 'x', or: [{ eq: 'y' }] }, then: 'first' }] },
            inputs: { input: '${tasks.first.outputs.result}' },
        });
        expect(() => validateWorkflow(value, false)).toThrow('exactly one');
    });

    it('rejects an explicit control kind without its configuration', () => {
        const value = workflow();
        value.tasks.push({ id: 'router', kind: 'route' } as never);
        expect(() => validateWorkflow(value, false)).toThrow('requires route');
    });

    it('accepts a route condition with a field path', () => {
        const value = workflow();
        value.tasks.push({
            id: 'router',
            route: { rules: [{ when: { path: ['kind'], eq: 'search' }, then: 'first' }] },
            depends_on: [], inputs: { input: '${tasks.first.outputs.result}' },
        });
        expect(validateWorkflow(value, false).tasks).toHaveLength(2);
    });

    it('rejects a task combining route and spawn (mutually exclusive kinds)', () => {
        const value = workflow();
        value.tasks.push({
            id: 'router',
            route: { rules: [{ when: 'x', then: 'first' }] },
            spawn: { tasks: [{ id: 'w', agent: 'agent', description: 'w' }], edges: [] },
            depends_on: [], inputs: { input: '${tasks.first.outputs.result}' },
        } as never);
        expect(() => validateWorkflow(value, false)).toThrow('cannot combine');
    });

    it('rejects unknown fields (strict schema)', () => {
        const value = workflow() as WorkflowConfigV1 & { tasks: Array<Record<string, unknown>> };
        (value.tasks[0] as Record<string, unknown>).typo_field = true;
        expect(() => validateWorkflow(value, false)).toThrow('Unrecognized');
    });

    it('accepts a worktree workspace policy with native sandbox', () => {
        const value = workflow();
        value.runtime = { workspace: { mode: 'worktree', base: 'head', merge: 'auto-if-clean', cleanup: 'keep' } };
        value.sandbox = { mode: 'native' };
        expect(validateWorkflow(value, false).runtime?.workspace).toMatchObject({ mode: 'worktree' });
    });

    it('rejects a worktree workspace policy without native sandbox', () => {
        const value = workflow();
        value.runtime = { workspace: { mode: 'worktree' } };
        expect(() => validateWorkflow(value, false)).toThrow('worktree requires sandbox.mode: native');
    });

    it('requires OCI for read-only workspaces', () => {
        const value = workflow();
        value.runtime = { workspace: { mode: 'read-only' } };
        value.sandbox = { mode: 'native' };
        expect(() => validateWorkflow(value, false)).toThrow('read-only requires sandbox.mode: oci');
        value.sandbox = { mode: 'oci' };
        expect(validateWorkflow(value, false).runtime?.workspace?.mode).toBe('read-only');
        value.runtime.workspace!.merge = 'auto-if-clean';
        expect(() => validateWorkflow(value, false)).toThrow('cannot merge changes');
    });
});

it('defaults the workspace to the invoking cwd and resolves an explicit root beside the config', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { loadWorkflow } = await import('../src/config');
    const directory = await mkdtemp(path.join(tmpdir(), 'nestos-default-workspace-'));
    try {
        const file = path.join(directory, 'flow.yml');
        await writeFile(file, JSON.stringify(workflow()));
        expect((await loadWorkflow(file, false)).workflow.workspaceRoot).toBe(process.cwd());
        await writeFile(file, JSON.stringify({ ...workflow(), workspace: { root: './project' } }));
        expect((await loadWorkflow(file, false)).workflow.workspaceRoot).toBe(path.join(directory, 'project'));
    } finally { await rm(directory, { recursive: true, force: true }); }
});
