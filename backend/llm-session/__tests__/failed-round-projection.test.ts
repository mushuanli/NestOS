import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@itookit/llm-context';
import type { PersistedRound } from '../src/persistence/round-types';
import { roundToProjection } from '../src/persistence/round-log';
import { SessionState } from '../src/session/session-state';
import { projectionGroups } from '../src/session/branch-service';

function round(id: string, status: PersistedRound['status'], error?: string, executions: PersistedRound['executions'] = []): PersistedRound {
    return {
        id,
        sessionId: 'test-session-id',
        historyParentIds: [],
        input: [{ role: 'user', content: 'run the harness' } as ChatMessage],
        output: [],
        executions,
        status,
        createdAt: 1,
        completedAt: 2,
        origin: 'user',
        error,
    };
}

describe('terminal round without assistant output', () => {
    it('projects a failed assistant placeholder so the transcript does not end on the user message', () => {
        const projection = roundToProjection(round('r1', 'failed', 'Load failed'), 'r1');

        expect(projection.assistantMessage).toMatchObject({
            content: '',
            status: 'failed',
            persistedNodeId: 'r1',
            error: 'Load failed',
        });

        const state = new SessionState('session');
        state.loadFromProjection(projection);
        expect(state.getLastSession()?.role).toBe('assistant');
    });

    it('maps a cancelled round onto an aborted assistant placeholder', () => {
        const projection = roundToProjection(round('r1', 'cancelled'), 'r1');
        expect(projection.assistantMessage).toMatchObject({ status: 'aborted', content: '' });
    });

    it('keeps the cancellation reason in reloaded history, not only in the live event stream', () => {
        const projection = roundToProjection(round('r1', 'cancelled', 'Task cancelled: task-1'), 'r1');

        // Reload path (BranchService) must carry the same terminal reason the live run showed.
        const groups = projectionGroups(projection);
        expect(groups).toHaveLength(2);
        expect(groups[1]).toMatchObject({
            role: 'assistant',
            roundId: 'r1',
            executionRoot: { status: 'aborted', data: { error: 'Task cancelled: task-1' } },
        });

        // Live path: a cancelled round arriving as a round:updated event carries it too.
        const state = new SessionState('session');
        state.apply({ type: 'round:appended', ref: 'main', roundId: 'r1', projection: roundToProjection(round('r1', 'pending'), 'r1') });
        const events = state.apply({
            type: 'round:updated',
            roundId: 'r1',
            changes: { status: 'cancelled', error: 'Task cancelled: task-1' },
        });
        const appended = events.find(event => event.type === 'message:appended');
        expect(appended!.payload.sessionGroup.executionRoot).toMatchObject({
            status: 'aborted',
            data: { error: 'Task cancelled: task-1' },
        });
    });

    it('keeps the tool calls a failed round had started, so the reloaded transcript shows them', () => {
        const persisted = round('r1', 'failed', 'Bash denied');
        persisted.result = {
            assistantBlocks: [{ type: 'tool_use', toolUseId: 'call-1', name: 'Bash', input: { command: 'pwd' } }],
            toolResults: [{ toolUseId: 'call-1', content: 'Bash denied', isError: true }],
        };

        const projection = roundToProjection(persisted, 'r1');

        expect(projection.assistantMessage).toMatchObject({
            status: 'failed',
            error: 'Bash denied',
            toolCalls: [{ toolId: 'call-1', name: 'Bash', result: 'Bash denied', isError: true }],
        });
        const groups = projectionGroups(projection);
        expect(groups[1].executionRoot?.children).toEqual([
            expect.objectContaining({ executorType: 'tool', name: 'Bash', status: 'failed' }),
        ]);
    });

    it('keeps user-only projection for non-terminal rounds', () => {
        const projection = roundToProjection(round('r1', 'running'), 'r1');
        expect(projection.assistantMessage).toBeUndefined();
    });

    it('materializes the placeholder when the failure arrives as a round:updated event', () => {
        const state = new SessionState('session');
        state.apply({ type: 'round:appended', ref: 'main', roundId: 'r1', projection: roundToProjection(round('r1', 'pending'), 'r1') });
        expect(state.getLastSession()?.role).toBe('user');

        const events = state.apply({
            type: 'round:updated',
            roundId: 'r1',
            changes: { status: 'failed', error: 'Load failed' },
        });

        const appended = events.find(event => event.type === 'message:appended');
        expect(appended).toBeDefined();
        expect(appended!.payload.sessionGroup).toMatchObject({ role: 'assistant', roundId: 'r1' });
        expect(appended!.payload.sessionGroup.executionRoot).toMatchObject({
            status: 'failed',
            data: { error: 'Load failed' },
        });
        expect(state.getLastSession()?.role).toBe('assistant');
    });
});

describe('round whose owning host disappeared', () => {
    const execution = [{ taskId: 'task-one', role: 'primary' as const }];

    it('projects an interrupted assistant so the transcript does not end on the user message', () => {
        const projection = roundToProjection(round('r1', 'running', undefined, execution), 'r1');

        expect(projection.assistantMessage).toMatchObject({ content: '', status: 'running', persistedNodeId: 'r1' });
        const state = new SessionState('session');
        state.loadFromProjection(projection);
        const last = state.getLastSession();
        expect(last?.role).toBe('assistant');
        // `SessionRegistry.getSnapshot()` reads exactly this to offer re-running the interrupted run.
        expect(last?.executionRoot?.status).toBe('running');
    });

    it('keeps a round that never started a run user-only', () => {
        expect(roundToProjection(round('r1', 'running'), 'r1').assistantMessage).toBeUndefined();
        expect(roundToProjection(round('r1', 'pending'), 'r1').assistantMessage).toBeUndefined();
    });

    it('does not report a run waiting for human input as interrupted work', () => {
        expect(roundToProjection(round('r1', 'waiting', undefined, execution), 'r1').assistantMessage).toMatchObject({ status: 'waiting_input' });
    });
});
