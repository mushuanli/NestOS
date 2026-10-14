import { describe, expect, it } from 'vitest';
import { registerDurablePrograms } from '@itookit/llm-flow';
import {
    createRunDefinitionFromFlow,
    parseSessionRoute,
    RunCatalog,
    toDagRunSpec,
    resolveMindOSProfile,
    sessionRoute,
    syncSkillsToKernel,
    workspaceRoot,
} from '../src/index';

describe('app-core shared headless services', () => {
    it('keeps workspace and Session route identities in one place', () => {
        expect(workspaceRoot('minds')).toBe('/home/admin/minds');
        expect(() => workspaceRoot('../etc')).toThrow('Invalid workspace identity');
        expect(parseSessionRoute('abc?branch=feature')).toEqual({ path: '/abc', branch: 'feature' });
        expect(sessionRoute('abc', 'feature')).toBe('abc?branch=feature');
    });

    it('registers the shared Durable programs idempotently', () => {
        const programs = new Map<string, unknown>();
        const kernel = {
            programs: {
                has: (kind: string, version: string) => programs.has(`${kind}@${version}`),
            },
            registerProgram: (program: { manifest: { kind: string; version: string } }) => {
                programs.set(`${program.manifest.kind}@${program.manifest.version}`, program);
            },
        };
        registerDurablePrograms(kernel as never);
        registerDurablePrograms(kernel as never);
        expect([...programs.keys()].sort()).toEqual([
            'flow.aggregate@1',
            'flow.dispatch@1',
            'flow.human@1',
            'flow.input@1',
            'flow.join@1',
            'flow.value@1',
            'llm.agent@1',
            'llm.chat@1',
            'llm.plan@1',
        ]);
    });

    it('syncs and prunes Kernel skills from the host driver', async () => {
        const saved: string[] = [];
        const deleted: string[] = [];
        const catalog = {
            names: new Set(['stale']),
            getSkillNames() { return [...this.names]; },
            async saveSkill(skill: { id: string }) { this.names.add(skill.id); saved.push(skill.id); },
            async deleteSkill(id: string) { this.names.delete(id); deleted.push(id); },
        };
        await syncSkillsToKernel({
            async getSkills() {
                return [{ id: 'review' } as never];
            },
        }, { skillCatalog: catalog });
        expect(saved).toEqual(['review']);
        expect(deleted).toEqual(['stale']);
        expect([...catalog.names]).toEqual(['review']);
    });
});

describe('MindOS profile resolution', () => {
    it('uses MINDOS_ROOT, then rootDir, then config-dir data default', () => {
        const base = { configDir: '/home/me/.config/mindos', resolvePath: (b: string, r: string) => `${b}/${r}` };
        expect(resolveMindOSProfile({ ...base, env: { MINDOS_ROOT: '/mnt/data' }, settings: { rootDir: '/ignored' } }).dataRoot).toBe('/mnt/data');
        expect(resolveMindOSProfile({ ...base, settings: { rootDir: 'data' } }).dataRoot).toBe('/home/me/.config/mindos/data');
        expect(resolveMindOSProfile({ ...base }).dataRoot).toBe('/home/me/.config/mindos/data');
    });
});

describe('RunDefinition', () => {
    it('compiles a FlowRevision without changing graph identity', async () => {
        const flow = {
            id: 'flow-1', revision: 3, name: 'Review', digest: 'sha256:abc', createdAt: 1,
            nodes: [{ id: 'agent', name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0', config: {}, inputs: {} }],
            edges: [{ id: 'edge', from: 'agent', to: 'agent', kind: 'control' }],
            connections: [{ name: 'default', connectionId: 'conn-1' }],
        } as never;
        const definition = await createRunDefinitionFromFlow(flow, { workspaceRoot: '/workspace' });
        expect(definition).toMatchObject({
            id: 'flow-1', revision: 3, source: 'flow', digest: 'sha256:abc',
            policy: { workspaceRoot: '/workspace' },
            environment: { connections: [{ id: 'default', provider: 'conn-1' }] },
        });
        expect(definition.graph.nodes[0].id).toBe('agent');
        expect(definition.graph.edges[0].id).toBe('edge');
    });
});

describe('toDagRunSpec', () => {
    it('preserves graph and run policy fields', async () => {
        const definition = await createRunDefinitionFromFlow({
            id: 'flow-1', revision: 1, name: 'Flow', digest: 'd', createdAt: 1,
            nodes: [{ id: 'n', name: 'N', plugin: 'builtin.agent', pluginVersion: '1.0.0', config: {}, inputs: {} }],
            edges: [],
            parameters: [{ name: 'maxRounds', type: 'number', default: 2 }],
            runPolicy: { maxConcurrency: 2, timeoutMs: 1000, maxTokens: 10 },
        } as never);
        expect(toDagRunSpec(definition)).toMatchObject({
            templateVersion: 1,
            parameterSchema: [{ name: 'maxRounds', type: 'number', default: 2 }],
            nodes: [{ id: 'n' }],
            maxConcurrency: 2,
            timeoutMs: 1000,
            maxTokens: 10,
            runPolicy: { maxConcurrency: 2, timeoutMs: 1000, maxTokens: 10 },
        });
        definition.graph.parameterScopes = { 'child/': { parent: '', defaults: { limit: 2 }, values: { limit: '${param.limit}' } } };
        const spec = toDagRunSpec(definition);
        expect(spec.parameterScopes).toEqual(definition.graph.parameterScopes);
        spec.parameterScopes!['child/'].defaults.limit = 3;
        expect(definition.graph.parameterScopes['child/'].defaults.limit).toBe(2);
    });
});

describe('RunCatalog', () => {
    it('projects flow-root tasks with Session origin and aggregate status', async () => {
        const sessions = {
            async list() { return [{ id: 's1', title: 'CLI: flow', origin: 'cli', createdAt: 1, updatedAt: 1 }]; },
            async getManifest(id: string) { return { id, title: 'CLI: flow', origin: 'cli', createdAt: 1, updatedAt: 1 }; },
        };
        const kernel = {
            async listSessionTasks() { return [
                { id: 'root', sessionId: 's1', rootTaskId: 'root', labels: { kind: 'flow-root' }, status: 'succeeded', createdAt: 1, updatedAt: 2 },
                { id: 'node', sessionId: 's1', rootTaskId: 'root', labels: { flowNodeId: 'n' }, status: 'succeeded', createdAt: 1, updatedAt: 3 },
            ] as never; },
        };
        const catalog = new RunCatalog(sessions as never, kernel as never);
        expect(await catalog.list()).toEqual([{ runId: 'root', sessionId: 's1', title: 'CLI: flow', origin: 'cli',
            status: 'succeeded', rootTaskId: 'root', createdAt: 1, updatedAt: 3 }]);
    });
});
