import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@itookit/llm-context';
import type { SessionGroup } from '../src/core/types';
import type { PersistedRound } from '../src/persistence/round-types';
import { roundToProjection } from '../src/persistence/round-log';
import { SessionState } from '../src/session/session-state';
import { hasRegenerateAssistant } from '../src/session/round-operations';

function makeRound(id: string, messages: ChatMessage[]): PersistedRound {
    return {
        id,
        sessionId: 'test-session-id',
        historyParentIds: [],
        input: messages.filter(message => message.role !== 'assistant'),
        output: messages.filter(message => message.role === 'assistant'),
        executions: [],
        status: 'completed',
        createdAt: Date.now(),
        completedAt: Date.now(),
        origin: 'user',
    };
}

describe('hasRegenerateAssistant', () => {
    it('forks a branch when the persisted Round has an assistant but the projection lags (not synced)', () => {
        const state = new SessionState('session');
        // Projection only knows the user message — RoundLog round:updated events
        // are not wired into state, so a completed assistant is invisible there.
        state.loadFromProjection(roundToProjection(
            makeRound('r1', [{ role: 'user', content: 'Q1' }]), 'r1',
        ));
        // Disk is authoritative and actually holds a completed assistant.
        const disk = makeRound('r1', [
            { role: 'user', content: 'Q1' },
            { role: 'assistant', content: 'A1' },
        ]);

        expect(hasRegenerateAssistant(state, disk, 'r1')).toBe(true);
    });

    it('fills the current round when neither projection nor disk has an assistant', () => {
        const state = new SessionState('session');
        const userOnly = makeRound('r1', [{ role: 'user', content: 'Q1' }]);
        state.loadFromProjection(roundToProjection(userOnly, 'r1'));

        expect(hasRegenerateAssistant(state, userOnly, 'r1')).toBe(false);
    });

    it('forks a branch when the projection already has an assistant', () => {
        const state = new SessionState('session');
        const withAssistant = makeRound('r1', [
            { role: 'user', content: 'Q1' },
            { role: 'assistant', content: 'A1' },
        ]);
        state.loadFromProjection(roundToProjection(withAssistant, 'r1'));

        expect(hasRegenerateAssistant(state, withAssistant, 'r1')).toBe(true);
    });

    it('finds the user round when given a session-group assistant id (round-X-assistant)', () => {
        const state = new SessionState('session');
        const withAssistant = makeRound('r1', [
            { role: 'user', content: 'Q1' },
            { role: 'assistant', content: 'A1' },
        ]);
        state.loadFromProjection(roundToProjection(withAssistant, 'r1'));

        // canRegenerate / regenerate pass the assistant session id, not the raw RoundId.
        const userRound = state.findUserRoundForAssistant('round-r1-assistant');
        expect(userRound?.userMessage?.content).toBe('Q1');
    });

    it('drops transient groups not in the head chain (stale branch bubbles)', () => {        const state = new SessionState('session');
        // Projection round on the new head chain.
        state.loadFromProjection(roundToProjection(makeRound('new', [{ role: 'user', content: 'Q2' }]), 'new'));
        // Transient assistant from the previous branch — must be removed on switch.
        const stale: SessionGroup = {
            id: 'round-old-assistant',
            persistedNodeId: 'old',
            role: 'assistant',
            content: 'stale',
            timestamp: Date.now(),
            origin: 'user',
            historyPolicy: 'include',
            roundId: 'old',
            executionRoot: {
                id: 'old', name: 'Assistant', executorType: 'agent', executorId: '',
                status: 'running', startTime: Date.now(), parentId: undefined, data: { output: 'stale' }, children: [],
            },
        };
        state.addPendingAssistantMessage(stale);

        const removed = state.retainTransientForRounds(new Set(['new']));

        expect(removed).toEqual(['round-old-assistant']);
        expect(state.getSessions().some(s => s.id === 'round-old-assistant')).toBe(false);
    });
});

describe('findUserRoundForAssistant guards', () => {
    it('accepts a non-chat round that carries a user message', () => {
        const state = new SessionState('session');
        // input[0] is a system message, so the round is projected as kind 'system'
        // even though it does carry the user prompt.
        const round: PersistedRound = {
            id: 'r1',
            sessionId: 'test-session-id',
            historyParentIds: [],
            input: [{ role: 'system', content: 'policy' }, { role: 'user', content: 'Q1' }],
            output: [{ role: 'assistant', content: 'A1' }],
            executions: [],
            status: 'completed',
            createdAt: Date.now(),
            completedAt: Date.now(),
            origin: 'user',
        };
        state.loadFromProjection(roundToProjection(round, 'r1'));

        expect(state.findUserRoundForAssistant('round-r1-assistant')?.userMessage?.content).toBe('Q1');
    });

    it('explains a message whose round is not projected', () => {
        const state = new SessionState('session');

        const reason = state.describeRegenerateFailure('round-missing-assistant');

        expect(reason).toContain('absent from the session projection');
        expect(reason).toContain('missing');
    });

    it('explains the parent chain of a projected round without a user message', () => {
        const state = new SessionState('session');
        const round: PersistedRound = {
            id: 'r1',
            sessionId: 'test-session-id',
            historyParentIds: [],
            input: [],
            output: [{ role: 'assistant', content: 'A1' }],
            executions: [],
            status: 'completed',
            createdAt: Date.now(),
            completedAt: Date.now(),
            origin: 'merge',
        };
        state.loadFromProjection(roundToProjection(round, 'r1'));

        const reason = state.describeRegenerateFailure('round-r1-assistant');

        expect(reason).toContain('r1[kind=merge,no-user]');
    });
});
