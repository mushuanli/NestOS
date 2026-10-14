import { describe, it, expect, afterEach } from 'vitest';
import { AgentResolver } from '../src/session/agent-resolver';

const connection = {
    id: 'default', name: 'Default', providerId: 'p1', protocol: 'openai', model: 'm1',
} as never;

const agentDefinition = {
    id: 'default', name: 'Default Assistant', type: 'agent',
    config: {},
} as never;

function service(overrides: Record<string, unknown> = {}): never {
    return {
        getAgentConfig: async (id: string) => (id === 'default' ? agentDefinition : null),
        getConnection: async () => connection,
        getDefaultConnection: async () => connection,
        getProvider: () => undefined,
        getAgents: async () => [],
        listAgents: () => [{ id: 'default' }],
        getSkills: async () => [],
        getSystemPrompt: async () => null,
        ...overrides,
    } as never;
}

describe('AgentResolver agentVersion', () => {
    afterEach(() => {
        // `subtle` lives on Crypto.prototype; drop the shadowing own property.
        delete (globalThis.crypto as { subtle?: unknown }).subtle;
    });

    it('hashes the definition when crypto.subtle is unavailable (insecure context)', async () => {
        Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });

        const resolver = new AgentResolver(service());
        const config = await resolver.resolveForChat('default');

        expect(config.agentVersion).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces a stable version for the same definition', async () => {
        const resolver = new AgentResolver(service());
        const first = await resolver.resolveForChat('default');
        const second = await resolver.resolveForChat('default');

        expect(first.agentVersion).toBe(second.agentVersion);
    });

    it('falls back without an agentVersion for an unknown agent id', async () => {
        const resolver = new AgentResolver(service());
        const config = await resolver.resolveForChat('missing');

        expect(config.id).toBe('default');
        expect(config.agentVersion).toBeUndefined();
    });
});


describe('independent connection selection', () => {
    it('resolves Agent identity without any model configuration', async () => {
        const resolver = new AgentResolver(service({ getDefaultConnection: async () => null }));
        const identity = await resolver.resolveForChat('default');
        expect(identity.agentVersion).toBeTruthy();
        expect(identity.connectionId).toBeUndefined();
        await expect(resolver.reResolveModel(identity, {})).rejects.toThrow('No default connection');
    });

    it('uses the explicit Session connection before the global default', async () => {
        const resolver = new AgentResolver(service({ getConnection: async (id: string) => id === 'chosen'
            ? { id, name: 'Chosen', providerId: 'p2', model: 'm2' } : null }));
        const identity = await resolver.resolveForChat('default');
        expect(await resolver.reResolveModel(identity, {})).toMatchObject({ connectionId: 'default', model: 'm1' });
        expect(await resolver.reResolveModel(identity, { connectionId: 'chosen' })).toMatchObject({ connectionId: 'chosen', model: 'm2' });
        await expect(resolver.reResolveModel(identity, { connectionId: 'missing' })).rejects.toThrow('Connection not found');
    });

    it('rejects a disabled connection instead of falling back', async () => {
        const resolver = new AgentResolver(service({ getConnection: async () => ({ id: 'off', providerId: 'p', enabled: false }) }));
        await expect(resolver.reResolveModel(await resolver.resolveForChat('default'), { connectionId: 'off' })).rejects.toThrow('disabled');
    });
});

describe('shared Agent prompts', () => {
    it('reads current shared content and appends Agent instructions, leaving prior configurations frozen', async () => {
        const prompt = { id: 'rules', content: ['Shared'] };
        const resolver = new AgentResolver(service({ getAgentConfig: async () => ({ id: 'a', name: 'A', type: 'agent', config: { systemPromptId: 'rules', systemPrompt: 'Additional' } }),
            getSystemPrompt: async () => prompt }));
        const before = await resolver.resolveForChat('a');
        expect(before.systemPrompt).toEqual(['Shared', 'Additional']);
        prompt.content[0] = 'Updated';
        expect((await resolver.resolveForChat('a')).systemPrompt).toEqual(['Updated', 'Additional']);
        expect(before.systemPrompt).toEqual(['Shared', 'Additional']);
    });
    it('rejects a missing prompt instead of silently omitting shared rules', async () => {
        const resolver = new AgentResolver(service({ getAgentConfig: async () => ({ id: 'a', name: 'A', type: 'agent', config: { systemPromptId: 'missing', systemPrompt: 'Additional' } }) }));
        await expect(resolver.resolveForChat('a')).rejects.toThrow('System prompt not found');
    });
});


it('resolves independent model reasoning efforts with legacy fallback', () => {
    const resolver = new AgentResolver(service({ getProvider: () => ({ models: [{ id: 'a' }, { id: 'b' }] }) }));
    const resolve = (resolver as unknown as { resolveThinkingConfig: (connection: unknown, tier: string, model: string) => unknown }).resolveThinkingConfig.bind(resolver);
    const conn = { providerId: 'p1', metadata: { reasoningEffort: 'medium', modelReasoningEfforts: { a: 'low', b: 'high' } } };
    expect(resolve(conn, 'optimal', 'a')).toEqual({ enableThinking: true, reasoningEffort: 'low' });
    expect(resolve(conn, 'standard', 'b')).toEqual({ enableThinking: true, reasoningEffort: 'high' });
    expect(resolve(conn, 'fast', 'legacy')).toEqual({ enableThinking: true, reasoningEffort: 'medium' });
});

it('allows hosts to reject missing agents without relaxing exact resolution', async () => {
    const resolver = new AgentResolver(service(), undefined, undefined, undefined, { missingAgent: 'reject' });
    await expect(resolver.resolveForChat('missing')).rejects.toThrow('Agent not found: missing');
    await expect(resolver.resolveExact('missing')).rejects.toThrow('Kernel requires exact agent resolution');
});

it('uses a host fallback only for chat and reports why resolution failed', async () => {
    const failures: unknown[] = [];
    const resolver = new AgentResolver(service(), undefined, undefined, undefined, {
        missingAgent: (id, failure) => { failures.push([id, failure]); return { id: 'custom', name: 'Custom', type: 'agent', agentVersion: 'v1' }; },
    });
    expect((await resolver.resolveForChat('missing')).id).toBe('custom');
    expect(failures).toEqual([['missing', { reason: 'not-found' }]]);
    await expect(resolver.resolveExact('missing')).rejects.toThrow('Agent not found');
    expect(failures).toHaveLength(1);
});
