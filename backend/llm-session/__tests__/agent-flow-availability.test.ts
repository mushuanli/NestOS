import { expect, it, vi } from 'vitest';
import type { AgentDefinition } from '@itookit/kernel-adapters/contracts';
import { AgentFlowAvailabilityProjection } from '../src/services/agent-flow-availability';
import type { SessionLogger } from '../src/utils/host-ports';

const agent: AgentDefinition = { id: 'entry', name: 'Entry', type: 'agent', config: {},
    execution: { kind: 'flow', flowId: 'generic-flow', parameters: { prompt: 'sensitive-prompt' } } };
const logger = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as SessionLogger);

it('fails closed with classified diagnostics without recording arguments or raw exception text', async () => {
    const log = logger(), stop = vi.fn(), projection = new AgentFlowAvailabilityProjection(log);
    projection.configure({ inspect: async () => { throw new Error('sensitive-prompt'); }, subscribe: () => stop }, vi.fn());
    await projection.refresh([agent]);
    expect(projection.project(agent).availability).toEqual({ status: 'disabled', reason: 'flow-invalid', flowId: 'generic-flow' });
    expect(log.error).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ operation: 'agent.flow.availability',
        operationId: expect.any(String), stage: 'inspect', result: 'disabled', category: 'Error', durationMs: expect.any(Number) }));
    expect(JSON.stringify((log.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('sensitive-prompt');
    expect(JSON.stringify((log.info as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('sensitive-prompt');
    projection.dispose(); expect(stop).toHaveBeenCalledOnce();
});

it('does not let an older availability inspection replace a newer resource observation', async () => {
    const projection = new AgentFlowAvailabilityProjection(logger());
    let resolve!: (value: { status: 'disabled'; reason: 'flow-missing' }) => void;
    const inspect = vi.fn().mockImplementationOnce(() => new Promise(done => { resolve = done; }))
        .mockResolvedValueOnce({ status: 'ready', flowId: 'generic-flow' });
    projection.configure({ inspect, subscribe: () => vi.fn() }, vi.fn());
    const previous = projection.refresh([agent]);
    projection.invalidate();
    await projection.refresh([agent]); resolve({ status: 'disabled', reason: 'flow-missing' }); await previous;
    expect(projection.project(agent).availability?.status).toBe('ready');
    projection.dispose();
});

it('shares inspection across readers and Agent aliases until the resource source changes', async () => {
    const projection = new AgentFlowAvailabilityProjection(logger()), inspect = vi.fn(async () => ({ status: 'ready' as const }));
    let changed!: () => void;
    projection.configure({ inspect, subscribe: listener => { changed = listener; return vi.fn(); } }, vi.fn());
    const aliases = [agent, { ...agent, id: 'another', execution: { ...agent.execution!, parameters: {} } }];
    await Promise.all([projection.refresh(aliases), projection.refresh([agent])]);
    await projection.refresh(aliases);
    expect(inspect).toHaveBeenCalledOnce();
    changed(); await projection.refresh(aliases);
    expect(inspect).toHaveBeenCalledTimes(2);
    await projection.refresh([{ ...agent, execution: { kind: 'flow', flowId: 'generic-flow', revision: 2 } }]);
    expect(inspect).toHaveBeenCalledTimes(3);
    projection.dispose();
});
