import { afterEach, expect, it, vi } from 'vitest';
import type { Kernel } from '@itookit/durable-kernel';
import { restoreFlowHistory } from '../src/persistence/restore-flow-history';
import { SessionRegistry } from '../src/session/session-registry';
import { RoundLog } from '../src/persistence/round-log';
import type { PersistedRound } from '../src/persistence/round-types';

afterEach(() => vi.restoreAllMocks());

function fixture() {
    const round = { id: 'r', sessionId: 's', status: 'running', createdAt: 1, historyParentIds: [], origin: 'user',
        input: [{ role: 'user', content: 'Review' }], output: [], flow: { flowId: 'essay', revision: 1 },
        executions: [{ taskId: 'root', role: 'primary' }] } as PersistedRound;
    const root = { id: 'root', program: { kind: 'flow.aggregate' }, labels: { kind: 'flow-root' }, input: { runTasks: [{ nodeId: 'check', taskId: 'check', iteration: 1, detached: false }] } };
    const tasks = [root, { id: 'check', program: { kind: 'llm.agent' }, status: 'running', createdAt: 2, interactions: {} },
        { id: 'other-branch', program: { kind: 'llm.agent' }, status: 'succeeded', createdAt: 3, output: 'Other branch' }];
    const taskEventPage = vi.fn(async (_session: string, _task: string, query: { afterIndex: number }) => query.afterIndex === 0
        ? { items: [{ type: 'agent.event', payload: { type: 'stream:thinking', delta: 'Thinking so far' } }], nextAfterIndex: 1, throughIndex: 2 }
        : { items: [{ type: 'agent.event', payload: { type: 'stream:content', delta: 'Partial answer' } }], throughIndex: 2 });
    const kernel = { listSessionTasks: async () => tasks, openSession: async () => ({ getShared: async () => undefined }), taskEventPage } as unknown as Kernel;
    return { round, kernel, taskEventPage };
}

it('rebuilds an unfinished Flow in a fresh registry from Task pages and isolates branches', async () => {
    const { round, kernel, taskEventPage } = fixture();
    const manifest = { currentHead: 'r', currentBranch: 'branch-8', branches: { main: null, 'branch-8': 'r' } };
    vi.spyOn(RoundLog.prototype, 'loadManifest').mockResolvedValue(manifest as never);
    vi.spyOn(RoundLog.prototype, 'readRound').mockResolvedValue(round);
    const write = vi.fn(() => { throw new Error('Recovery must be read-only'); });
    const registry = new SessionRegistry({ getManifest: async () => manifest, writeDocument: write, updateManifest: write } as never, value => restoreFlowHistory(kernel, value));
    const snapshot = await registry.bindSession('s');
    const assistant = snapshot.sessions.find(group => group.role === 'assistant');
    expect(assistant?.executionRoot?.children).toHaveLength(1);
    expect(assistant?.executionRoot?.children[0]).toMatchObject({ id: 'flow-check', data: { output: 'Partial answer', thought: 'Thinking so far' } });
    expect(taskEventPage.mock.calls.map(call => call[1])).toEqual(['check', 'check']);
    expect(round.result).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
});

it('preserves a completed persisted transcript without requiring Task journals', async () => {
    const { round } = fixture();
    round.status = 'completed';
    round.result = { assistantBlocks: [], toolResults: [], flowInteractions: [{ id: 'saved', taskId: 'check', role: 'assistant', name: 'Check', status: 'success', content: 'Saved', createdAt: 1 }] };
    expect(await restoreFlowHistory({} as Kernel, round)).toBe(round);
});
