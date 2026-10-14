// @file: llm-runtime/__tests__/round-log.test.ts
// Integration tests for RoundLog with an in-memory ISessionRepository mock.
//
// Covers:
//   - RoundLog CRUD: append, fold, readRound, writeRound
//   - Delete semantics: user→cascade, assistant→keep, resend→no-branch
//   - Children reverse index + fold caching + soft-delete filtering
//   - Event emission: round:appended, round:updated, round:deleted

import { beforeEach, describe, expect, it } from 'vitest';
import type { ISessionRepository, FSNode } from '../src/persistence/types';
import type { RoundManifest, PersistedRound, RoundProjection } from '../src/persistence/round-types';
import type { RoundLogEvent } from '../src/persistence/round-events';
import { RoundLog, roundToProjection } from '../src/persistence/round-log';
import { SessionState } from '../src/session/session-state';

// ── In-memory ISessionRepository mock ──────────────────────────────────────────────

class InMemorySessionRepository implements Partial<ISessionRepository> {
    private manifest: Record<string, unknown> = {};
    /** ownerNodeId → Map<assetName, content> */
    private assets: Map<string, Map<string, string>> = new Map();
    private files: Map<string, string> = new Map();
    private children: Map<string, FSNode[]> = new Map();

    // ── Manifest ────────────────────────────────────────────────────────

    async getManifest(_nodeId: string): Promise<unknown> {
        const persisted = this.files.get(_nodeId);
        return persisted ? JSON.parse(persisted) : { ...this.manifest };
    }

    async updateManifest(sessionId: string, updates: Record<string, unknown>): Promise<void> {
        const current = await this.getManifest(sessionId) as Record<string, unknown>;
        this.files.set(sessionId, JSON.stringify({ ...current, ...updates }));
    }

    setManifest(m: Record<string, unknown>): void {
        this.manifest = m;
    }

    // ── Asset directory ─────────────────────────────────────────────────

    async getAssetDirectoryId(sessionId: string): Promise<string | null> {
        return `_${sessionId}`;
    }

    /** ownerNodeId is the .chat file id; name is relative asset filename */
    async writeDocument(ownerNodeId: string, name: string, content: string): Promise<FSNode> {
        if (!this.assets.has(ownerNodeId)) this.assets.set(ownerNodeId, new Map());
        this.assets.get(ownerNodeId)!.set(name, content);
        const path = `_${ownerNodeId}/${name}`;
        this.files.set(path, content);
        return { path, name } as unknown as FSNode;
    }

    async getAssets(ownerNodeId: string): Promise<FSNode[]> {
        const map = this.assets.get(ownerNodeId) ?? new Map();
        return Array.from(map.keys()).map(name => ({
            name, path: `_${ownerNodeId}/${name}`,
        } as unknown as FSNode));
    }

    async readDocument(sessionId: string, name: string): Promise<string | null> {
        return this.assets.get(sessionId)?.get(name) ?? null;
    }

    // ── Content ──────────────────────────────────────────────────────────

    async readContent(path: string): Promise<string | ArrayBuffer> {
        if (this.files.has(path)) return this.files.get(path)!;
        throw new Error(`File not found: ${path}`);
    }

    // ── Directory ────────────────────────────────────────────────────────

    async getChildren(dirPath: string): Promise<FSNode[]> {
        return this.children.get(dirPath) ?? [];
    }

    async createDirectory(name: string, parentPath: string): Promise<FSNode> {
        const path = `${parentPath}/${name}`;
        this.children.set(path, []);
        return { path, name } as unknown as FSNode;
    }

    // ── Delete ───────────────────────────────────────────────────────────

    async delete(paths: string[]): Promise<void> {
        for (const p of paths) {
            this.files.delete(p);
        }
    }

}

// ── Test helpers ────────────────────────────────────────────────────────────

function makeRound(
    overrides: Partial<Round> & { messages?: ChatMessage[] } = {},
): Round {
    const { messages = [], ...roundOverrides } = overrides;
    return {
        id: '',
        sessionId: 'test-session-id',
        historyParentIds: [],
        input: messages.filter(message => message.role !== 'assistant'),
        output: messages.filter(message => message.role === 'assistant'),
        executions: [],
        status: 'completed',
        createdAt: Date.now(),
        completedAt: Date.now(),
        origin: 'user',
        ...roundOverrides,
    };
}

function makeUserPayload(text: string): ChatMessage[] {
    return [{ role: 'user' as const, content: text }];
}

function makeAssistantPayload(text: string): ChatMessage[] {
    return [{ role: 'assistant' as const, content: text }];
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RoundLog', () => {
    let engine: InMemorySessionRepository;
    let log: RoundLog;
    let events: RoundLogEvent[];
    const sessionId = 'test-session-id';

    beforeEach(() => {
        engine = new InMemorySessionRepository();
        engine.setManifest({
            schemaVersion: 3,
            id: sessionId,
            title: 'Test',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            rootRoundId: 'root',
            branches: { main: 'root' },
            branchMeta: {},
            currentBranch: 'main',
            currentHead: 'root',
            children: {},
        });
        events = [];
        log = new RoundLog(engine as unknown as ISessionRepository, sessionId);
        log.setEventListener((e) => events.push(e));
    });

    // ── Basic CRUD ────────────────────────────────────────────────────────

    describe('terminal status projection', () => {
        it('persists the cancellation reason and emits it, so reloaded history keeps the cause', async () => {
            const roundId = await log.append('main', makeRound({ id: 'r-cancel', messages: makeUserPayload('go') }));

            await log.setConversationStatus(roundId, 'cancelled', 'Task cancelled: task-1');

            const persisted = await log.readRound(roundId);
            expect(persisted).toMatchObject({ status: 'cancelled', error: 'Task cancelled: task-1' });
            // The live event carries the same reason the reload path will project.
            expect(events.at(-1)).toMatchObject({ type: 'round:updated', changes: { status: 'aborted', error: 'Task cancelled: task-1' } });
            expect(roundToProjection(persisted!, roundId).assistantMessage).toMatchObject({ status: 'aborted', error: 'Task cancelled: task-1' });
        });
    });

    describe('append & fold', () => {
        it('rejects a stale expected branch head before writing', async () => {
            const round = makeRound({ id: 'new', messages: makeUserPayload('Hello') });
            await expect(log.appendExpected('main', round, null)).rejects.toMatchObject({ code: 'HEAD_CONFLICT' });
            expect(await log.readRound('new')).toBeNull();
        });

        it('should append a round and fold returns its messages', async () => {
            const round = makeRound({ messages: [{ role: 'user', content: 'Hello' }] });
            const roundId = await log.append('main', round);

            const messages = await log.fold('main');
            expect(messages).toHaveLength(1);
            expect(messages[0]).toEqual({ role: 'user', content: 'Hello' });
        });

        it('should append multiple rounds and fold returns them in order', async () => {
            const t1 = makeRound({ messages: [{ role: 'user', content: 'Q1' }] });
            const t1Id = await log.append('main', t1);
            const t2 = makeRound({
                historyParentIds: [t1Id],
                messages: [{ role: 'assistant', content: 'A1' }],
            });
            const t2Id = await log.append('main', t2);
            const t3 = makeRound({
                historyParentIds: [t2Id],
                messages: [{ role: 'user', content: 'Q2' }],
            });
            await log.append('main', t3);

            const messages = await log.fold('main');
            expect(messages).toHaveLength(3);
            expect(messages[0]).toEqual({ role: 'user', content: 'Q1' });
            expect(messages[1]).toEqual({ role: 'assistant', content: 'A1' });
            expect(messages[2]).toEqual({ role: 'user', content: 'Q2' });
        });

        it('should NOT trim trailing assistant from fold (provider validation is Phase 2)', async () => {
            const t1 = makeRound({ messages: [{ role: 'user', content: 'Q1' }] });
            const t1Id = await log.append('main', t1);
            const t2 = makeRound({
                historyParentIds: [t1Id],
                messages: [{ role: 'assistant', content: 'A1' }],
            });
            await log.append('main', t2);

            // Phase 0: trailing assistant is NOT removed by fold().
            // Provider-specific validation will move to ProviderMessageAdapter in Phase 2.
            const messages = await log.fold('main');
            expect(messages).toHaveLength(2);
            expect(messages[0]).toEqual({ role: 'user', content: 'Q1' });
            expect(messages[1]).toEqual({ role: 'assistant', content: 'A1' });
        });

        it('should skip empty assistant messages in fold', async () => {
            const t1 = makeRound({ messages: [
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: '' },
            ]});
            await log.append('main', t1);

            const messages = await log.fold('main');
            expect(messages).toHaveLength(1);
            expect(messages[0].role).toBe('user');
        });
    });

    // ── Delete semantics (core acceptance criteria) ─────────────────────

    describe('delete user round → cascade delete assistant', () => {
        it('fold() should skip deleted rounds and SessionState should cascade', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            const t2Id = await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: makeAssistantPayload('A1'),
            }));
            const t3Id = await log.append('main', makeRound({
                historyParentIds: [t2Id],
                messages: makeUserPayload('Q2'),
            }));
            const t4Id = await log.append('main', makeRound({
                historyParentIds: [t3Id],
                messages: makeAssistantPayload('A2'),
            }));

            // Delete user round T3 — T4 should cascade in SessionState projection
            await log.deleteRound(t3Id);

            // fold() skips _deleted rounds (T3).
            // Phase 0: trailing assistant is no longer trimmed — provider
            // validation will move to ProviderMessageAdapter in Phase 2.
            const messages = await log.fold('main');
            expect(messages).toHaveLength(3); // Q1, A1, A2 (T3 deleted, no trim)
            expect(messages[0]).toEqual({ role: 'user', content: 'Q1' });
            expect(messages[1]).toEqual({ role: 'assistant', content: 'A1' });
            expect(messages[2]).toEqual({ role: 'assistant', content: 'A2' });

            // Verify SessionState cascade
            const state = new SessionState(sessionId);
            for (const tId of [t1Id, t2Id, t3Id, t4Id]) {
                const t = await log.readRound(tId);
                if (t && !t._deleted) state.loadFromProjection(roundToProjection(t, tId));
            }
            const cascadeIds = getCascadeRoundIds(state, t3Id);
            expect(cascadeIds).toContain(t3Id);
            expect(cascadeIds).toContain(t4Id);
        });
    });

    describe('delete assistant round → keep user', () => {
        it('should keep the user round visible after deleting assistant', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            const t2Id = await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: makeAssistantPayload('A1'),
            }));

            await log.deleteRound(t2Id);

            const messages = await log.fold('main');
            expect(messages).toHaveLength(1);
            expect(messages[0]).toEqual({ role: 'user', content: 'Q1' });

            // T1 should NOT be marked _deleted
            const t1 = await log.readRound(t1Id);
            expect(t1).not.toBeNull();
            expect(t1!._deleted).toBeFalsy();

            // T2 should be marked _deleted
            const t2 = await log.readRound(t2Id);
            expect(t2!._deleted).toBe(true);
        });
    });

    describe('resend (clearAssistantInRound) → no new branch', () => {
        it('should replace an empty assistant in the same round without creating a branch', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            const t2Id = await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: [
                    { role: 'user', content: 'Q1' },
                    { role: 'assistant', content: 'A1' },
                ],
            }));

            await log.clearAssistantInRound(t2Id);

            // fold should show Q1 from both T1 and T2 user message
            const messages = await log.fold('main');
            expect(messages).toHaveLength(2);
            expect(messages[0]).toEqual({ role: 'user', content: 'Q1' });
            expect(messages[1]).toEqual({ role: 'user', content: 'Q1' });

            // T2 should have no assistant payload
            const t2 = await log.readRound(t2Id);
            expect(t2!.output).toEqual([]);
            expect(t2!.result).toBeUndefined();

            await log.setAssistantInRound(t2Id, {
                assistantMessages: [{ role: 'assistant', content: 'A1-resend' }],
                agentId: 'configured-agent',
            });

            const replaced = await log.readRound(t2Id);
            expect(replaced!.id).toBe(t2Id);
            expect(replaced!.historyParentIds).toEqual([t1Id]);
            expect(replaced!.input).toEqual([{ role: 'user', content: 'Q1' }]);
            expect(replaced!.output).toEqual([
                { role: 'assistant', content: 'A1-resend' },
            ]);
            expect(replaced!.agentId).toBe('configured-agent');

            // Same Round remains the branch head; no sibling/branch is created.
            const manifest = await log.loadManifest();
            expect(Object.keys(manifest.branches)).toEqual(['main']);
            expect(manifest.branches.main).toBe(t2Id);
            expect(manifest.currentHead).toBe(t2Id);

            await expect(log.setAssistantInRound(t2Id, {
                assistantMessages: [{ role: 'assistant', content: 'must-not-overwrite' }],
            })).rejects.toMatchObject({ code: 'ROUND_ALREADY_COMPLETED' });
        });
    });

    // ── Fork (regenerate) ─────────────────────────────────────────────────

    describe('forkUserRound for regenerate', () => {
        it('persists the new user round and points currentHead at it so the chain resolves', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            const t2Id = await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: [
                    { role: 'user', content: 'Q1' },
                    { role: 'assistant', content: 'A1' },
                ],
            }));

            const forked = await log.forkUserRound(t2Id, { createdFrom: 'regenerate' });
            const manifest = await log.loadManifest();

            // New branch head points at the freshly-persisted user Round.
            expect(manifest.currentBranch).toBe(forked.branchName);
            expect(manifest.currentHead).toBe(forked.newRoundId);
            expect(manifest.branches[forked.branchName]).toBe(forked.newRoundId);

            // The new Round is persisted with the shared history as its parent —
            // a head chain from it resolves the whole conversation.
            const newRound = await log.readRound(forked.newRoundId);
            expect(newRound).not.toBeNull();
            expect(newRound!.historyParentIds).toEqual([t1Id]);

            // fold from the new branch should include the shared Q1 user message.
            const messages = await log.fold(forked.branchName);
            expect(messages.some(m => m.role === 'user' && m.content === 'Q1')).toBe(true);
        });
    });

    // ── Children reverse index ────────────────────────────────────────────

    describe('children reverse index', () => {
        it('should maintain children index across append operations', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            const t2Id = await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: makeAssistantPayload('A1'),
            }));

            const manifest = await log.loadManifest();
            expect(manifest.children[t1Id]).toBeDefined();
            expect(manifest.children[t1Id]).toContain(t2Id);
        });

        it('should support O(1) sibling lookup via children index', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            const t2aId = await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: makeAssistantPayload('A1-v1'),
            }));

            // Simulate regenerate: another assistant under the same parent
            const t2bId = await log.append('main', makeRound({
                id: 'sibling-round-id',
                historyParentIds: [t1Id],
                messages: makeAssistantPayload('A1-v2'),
            }));

            const manifest = await log.loadManifest();
            const siblings = manifest.children[t1Id] ?? [];
            expect(siblings.length).toBeGreaterThanOrEqual(2);
            expect(siblings).toContain(t2aId);
            expect(siblings).toContain(t2bId);
        });
    });

    it('commits a run as one conversation round without nested rounds', async () => {
        await log.append('main', makeRound({
            id: 'conversation-round',
            historyParentIds: [],
            input: [{ role: 'user', content: 'analyze' }],
            output: [],
            executions: [{ runId: 'run-1', role: 'primary' }],
            status: 'running',
            createdAt: 1,
        }));

        await log.setAssistantInRound('conversation-round', {
            assistantMessages: [{ role: 'assistant', content: 'done' }],
        });
        const stored = await log.readRound('conversation-round');
        const manifest = await log.loadManifest();

        expect(stored?.status).toBe('completed');
        expect(stored?.output).toEqual([{ role: 'assistant', content: 'done' }]);
        expect(stored?.executions).toEqual([{ runId: 'run-1', role: 'primary' }]);
        expect(manifest.children['conversation-round']).toBeUndefined();
    });

    it('applies branch context profile rules to fold()', async () => {
        await log.append('main', makeRound({
            id: 'context-r1',
            historyParentIds: [],
            messages: [{ role: 'user', content: 'exclude me' }, { role: 'assistant', content: 'old answer' }],
        }));
        await log.append('main', makeRound({
            id: 'context-r2',
            historyParentIds: ['context-r1'],
            messages: [{ role: 'user', content: 'keep me' }, { role: 'assistant', content: 'new answer' }],
        }));

        await log.setRoundContextRules('main', ['context-r1'], 'exclude');
        expect((await log.fold('main')).map(message => message.content)).toEqual(['keep me', 'new answer']);

        await log.setRoundContextRules('main', ['context-r1'], 'include');
        expect((await log.fold('main')).map(message => message.content)).toEqual([
            'exclude me', 'old answer', 'keep me', 'new answer',
        ]);
    });

    // ── Soft-delete filtering in fold ─────────────────────────────────────

    describe('soft-delete filtering', () => {
        it('fold() should skip _deleted rounds', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            const t2Id = await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: makeAssistantPayload('A1'),
            }));

            await log.deleteRound(t2Id);

            const messages = await log.fold('main');
            const deletedRoundIds = (await Promise.all(
                [t1Id, t2Id].map(id => log.readRound(id)),
            )).filter(t => t?._deleted).map(t => t!.id);

            expect(deletedRoundIds).toContain(t2Id);
            expect(deletedRoundIds).not.toContain(t1Id);
        });
    });

    // ── Event emission ────────────────────────────────────────────────────

    describe('event emission', () => {
        it('should emit round:appended on append', async () => {
            await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));

            expect(events.length).toBeGreaterThanOrEqual(1);
            expect(events[0].type).toBe('round:appended');
            expect((events[0] as any).projection).toBeDefined();
        });

        it('should emit round:updated on clearAssistantInRound', async () => {
            const t1Id = await log.append('main', makeRound({ messages: [
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
            ]}));

            const beforeCount = events.length;
            await log.clearAssistantInRound(t1Id);

            const newEvents = events.slice(beforeCount);
            expect(newEvents.length).toBeGreaterThanOrEqual(1);
            expect(newEvents[0].type).toBe('round:updated');
        });

        it('should emit round:updated on markStale', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));

            const beforeCount = events.length;
            await log.markStale(t1Id);

            const newEvents = events.slice(beforeCount);
            expect(newEvents.length).toBeGreaterThanOrEqual(1);
            expect(newEvents[0].type).toBe('round:updated');
            expect((newEvents[0] as any).changes.stale).toBe(true);
        });

        it('should emit round:deleted on deleteRound', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));

            const beforeCount = events.length;
            await log.deleteRound(t1Id);

            const newEvents = events.slice(beforeCount);
            expect(newEvents.length).toBeGreaterThanOrEqual(1);
            expect(newEvents[0].type).toBe('round:deleted');
        });
    });

    // ── Fold cache ────────────────────────────────────────────────────────

    describe('fold caching', () => {
        it('should invalidate cache on append', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            const first = await log.fold('main'); // populate cache
            await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: makeUserPayload('Q2'),
            }));

            const second = await log.fold('main');
            expect(second.length).toBeGreaterThan(first.length);
        });

        it('should invalidate cache on delete', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            await log.fold('main'); // populate cache
            await log.deleteRound(t1Id);

            const messages = await log.fold('main');
            expect(messages).toHaveLength(0);
        });
    });

    // ── Manifest read/write ──────────────────────────────────────────────

    describe('manifest management', () => {
        it('should bootstrap manifest on first access', async () => {
            engine.setManifest({}); // empty manifest
            const freshLog = new RoundLog(engine as unknown as ISessionRepository, sessionId);

            const manifest = await freshLog.loadManifest();
            // RoundManifest has no format field;
            expect(manifest.branches.main).toBeDefined();
        });

        it('should persist children index in manifest', async () => {
            const t1Id = await log.append('main', makeRound({ messages: makeUserPayload('Q1') }));
            await log.append('main', makeRound({
                historyParentIds: [t1Id],
                messages: makeAssistantPayload('A1'),
            }));

            const manifest = await log.loadManifest();
            expect(manifest.children).toBeDefined();
            const children = manifest.children[t1Id] ?? [];
            expect(children.length).toBeGreaterThanOrEqual(1);
        });
    });

    // ── Read/write turn files ─────────────────────────────────────────────

    describe('readRound / writeRound', () => {
        it('should persist and read back round data', async () => {
            const roundId = await log.append('main', makeRound({
                messages: makeUserPayload('Hello World'),
            }));

            const persisted = await log.readRound(roundId);
            expect(persisted).not.toBeNull();
            expect(persisted!.input[0].content).toBe('Hello World');
        });

        it('should return null for non-existent round', async () => {
            const result = await log.readRound('non-existent-id');
            expect(result).toBeNull();
        });
    });
});

// ── Tool invocation projection ─────────────────────────────────────────────

describe('roundToProjection (tool calls)', () => {
    it('projects persisted tool_use blocks and tool results', () => {
        const round = makeRound({
            messages: [...makeUserPayload('Q1'), ...makeAssistantPayload('A1')],
            result: {
                assistantBlocks: [
                    { type: 'text', content: 'A1' },
                    { type: 'tool_use', toolUseId: 'call-1', name: 'read', input: { path: 'a.md' } },
                ],
                toolResults: [{ toolUseId: 'call-1', content: 'file content', isError: false }],
                usage: { total_tokens: 10 },
            },
        });
        const projection = roundToProjection(round, 'r1');
        expect(projection.assistantMessage?.toolCalls).toEqual([
            { toolId: 'call-1', name: 'read', input: { path: 'a.md' }, result: 'file content', isError: false },
        ]);
    });

    it('builds tool children into the assistant execution tree', () => {
        const state = new SessionState('session');
        state.loadFromProjection(projection('r1', [], 1, {
            userMessage: { content: 'Q1', persistedNodeId: 'r1' },
            assistantMessage: {
                content: 'A1',
                status: 'success',
                persistedNodeId: 'r1',
                toolCalls: [{ toolId: 'call-1', name: 'read', result: 'x', isError: false }],
            },
        }));
        const assistant = state.getSessions().find(group => group.role === 'assistant');
        expect(assistant?.executionRoot?.children).toHaveLength(1);
        expect(assistant?.executionRoot?.children?.[0].executorType).toBe('tool');
    });
});

// ── SessionState projection tests ──────────────────────────────────────────

describe('SessionState (round format)', () => {
    it('should cascade delete children via collectCascadeRoundIds', () => {
        const state = new SessionState('session');

        const p1: RoundProjection = projection('t1', [], 1, {
            userMessage: { content: 'Q1', persistedNodeId: 't1' },
        });
        const p2: RoundProjection = projection('t2', ['t1'], 2, {
            assistantMessage: { content: 'A1', status: 'success', persistedNodeId: 't2' },
        });
        const p3: RoundProjection = projection('t3', ['t2'], 3, {
            userMessage: { content: 'Q2', persistedNodeId: 't3' },
        });
        const p4: RoundProjection = projection('t4', ['t3'], 4, {
            assistantMessage: { content: 'A2', status: 'success', persistedNodeId: 't4' },
        });

        for (const p of [p1, p2, p3, p4]) state.loadFromProjection(p);

        const cascadeIds = getCascadeRoundIds(state, 't3');
        expect(cascadeIds).toContain('t3');
        expect(cascadeIds).toContain('t4');
        expect(cascadeIds).not.toContain('t1');
        expect(cascadeIds).not.toContain('t2');
    });

    it('should apply round:appended event', () => {
        const state = new SessionState('session');

        const events = state.apply({
            type: 'round:appended',
            ref: 'main',
            roundId: 't1',
            projection: {
                roundId: 't1',
                historyParentIds: [],
                kind: 'chat',
                userMessage: { content: 'Hello', persistedNodeId: 't1' },
                createdAt: 1,
                origin: 'user',
            },
        });

        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('message:appended');
    });
});

// ── Helper ─────────────────────────────────────────────────────────────────

/** Access the private collectCascadeRoundIds via apply("round:deleted"). */
function getCascadeRoundIds(state: SessionState, roundId: string): string[] {
    const events = state.apply({ type: 'round:deleted', roundId });
    const deletedEvent = events.find(e => e.type === 'messages:deleted');
    if (deletedEvent && 'payload' in deletedEvent) {
        return (deletedEvent.payload as { deletedIds: string[] }).deletedIds;
    }
    return [];
}

function projection(
    roundId: string,
    historyParentIds: string[],
    createdAt: number,
    messages: Pick<RoundProjection, 'userMessage' | 'assistantMessage'>,
): RoundProjection {
    return {
        roundId,
        historyParentIds,
        kind: 'chat',
        createdAt,
        origin: 'user',
        ...messages,
    };
}

describe('Flow rerun branches', () => {
    it.each([false, true])('reruns Session metadata with an empty current branch (prior run=%s)', async priorRun => {
        const { FlowRerunService } = await import('../src/session/flow-rerun');
        const { FlowDefinitionStore } = await import('@itookit/llm-flow');
        const { vi } = await import('vitest');
        const draftLoad = vi.spyOn(FlowDefinitionStore.prototype, 'loadDraft').mockResolvedValue(null);
        const engine = new InMemorySessionRepository(), log = new RoundLog(engine as never, 's');
        const flow = { flowId: 'review', revision: 3, parameters: { essay: 'initial' } };
        engine.setManifest({ flow });
        if (priorRun) {
            await log.append('main', makeRound({ id: 'old', sessionId: 's', flow: { ...flow, parameters: { essay: 'last' } } as never }));
            await log.createBranchForReplacement(null, 'unused', { createdFrom: 'manual', branchName: 'empty' });
        }
        const registry = { engine, ensureBound: () => ({ sessionId: 's', state: { getRounds: () => [] }, runtime: {} }),
            ensureNotGenerating() {}, reloadSessionData: async () => {}, eventBus: { emitSession: vi.fn() } };
        const submit = vi.fn(async (input: any) => {
            const manifest = await log.loadManifest();
            expect(manifest.currentHead).toBeNull();
            await log.appendExpected(manifest.currentBranch, makeRound({ id: input.roundTarget.roundId, sessionId: 's', flow: input.sendIntent.execution }), null);
            return 'new-task';
        });
        const load = vi.spyOn(FlowDefinitionStore.prototype, 'loadRevision').mockResolvedValue({ ...flow, id: 'review', name: 'Review', parameters: [] } as never);
        try {
            const service = new FlowRerunService(registry as never, { submit, assertCanSubmit: async () => {} } as never, {} as never);
            const context = await service.context();
            expect(context?.flow.parameters).toEqual({ essay: priorRun ? 'last' : 'initial' });
            expect(context?.sourceRoundId).toBe(priorRun ? 'old' : null);
            const before = await log.loadManifest();
            const result = await service.run({ essay: 'new' }, context!.sourceRoundId);
            const after = await log.loadManifest();
            expect(result.branchName).not.toBe(before.currentBranch);
            for (const [name, head] of Object.entries(before.branches)) expect(after.branches[name]).toBe(head);
            expect(submit).toHaveBeenCalledOnce();
        } finally { load.mockRestore(); draftLoad.mockRestore(); }
    });

    it('lists only the execution references in each persisted branch', async () => {
        const { flowBranchExecutions } = await import('../src/session/flow-branches');
        const engine = new InMemorySessionRepository(), log = new RoundLog(engine as never, 's');
        await log.append('main', makeRound({ id: 'old', executions: [{ taskId: 'old-task', role: 'primary' }] }));
        await log.createBranchForReplacement(null, 'new', { branchName: 'rerun', createdFrom: 'regenerate' });
        await log.append('rerun', makeRound({ id: 'new', executions: [{ taskId: 'new-task', role: 'primary' }] }));
        await log.createBranchForReplacement(null, 'empty-root', { branchName: 'empty', createdFrom: 'manual' });
        expect(await flowBranchExecutions(engine as never, 's')).toEqual({ sessionId: 's', currentBranch: 'empty', branches: [
            { name: 'main', taskIds: ['old-task'], runs: [] }, { name: 'rerun', taskIds: ['new-task'], runs: [] }, { name: 'empty', taskIds: [], runs: [] },
        ] });
    });

    it('validates before forking and persists new parameters without changing the source', async () => {
        const { FlowRerunService } = await import('../src/session/flow-rerun');
        const { FlowDefinitionStore } = await import('@itookit/llm-flow');
        const { vi } = await import('vitest');
        const draftLoad = vi.spyOn(FlowDefinitionStore.prototype, 'loadDraft').mockResolvedValue(null);
        const engine = new InMemorySessionRepository();
        const log = new RoundLog(engine as never, 's');
        const source = makeRound({ id: 'original', sessionId: 's', input: [{ role: 'user', content: 'old' }],
            output: [{ role: 'assistant', content: 'old result' }], flow: { flowId: 'review' as never, revision: 3, parameters: { essay: 'old' } } });
        await log.append('main', source);
        let rounds = [roundToProjection(source, source.id)];
        const registry = { engine, ensureBound: () => ({ sessionId: 's', state: { getRounds: () => rounds }, runtime: {} }),
            ensureNotGenerating() {}, reloadSessionData: async () => {}, eventBus: { emitSession: vi.fn() } };
        const submit = vi.fn(async (input: any) => {
            const manifest = await log.loadManifest();
            const next = makeRound({ id: input.roundTarget.roundId, sessionId: 's', input: [{ role: 'user', content: input.text }],
                output: [{ role: 'assistant', content: 'new result' }], flow: input.sendIntent.execution });
            await log.appendExpected(manifest.currentBranch, next, manifest.currentHead);
            rounds = [roundToProjection(next, next.id)];
            return 'task-new';
        });
        const revision = vi.spyOn(FlowDefinitionStore.prototype, 'loadRevision').mockResolvedValue({
            id: 'review', revision: 3, name: 'Review', parameters: [{ name: 'essay', type: 'string', required: true }],
        } as never);
        const publish = vi.spyOn(FlowDefinitionStore.prototype, 'createRevision').mockImplementation(async draft => ({ ...draft, revision: 4, createdAt: 1 }) as never);
        try {
            const assertCanSubmit = vi.fn(async () => {});
            const service = new FlowRerunService(registry as never, { submit, assertCanSubmit } as never, {} as never);
            const before = await log.loadManifest();
            assertCanSubmit.mockRejectedValueOnce(new Error('Session is closed'));
            await expect(service.run({ essay: 'new' }, 'original')).rejects.toThrow('Session is closed');
            expect(await log.loadManifest()).toEqual(before);
            expect(submit).not.toHaveBeenCalled();
            await expect(service.run({}, 'original')).rejects.toThrow();
            expect(Object.keys((await log.loadManifest()).branches)).toEqual(['main']);
            const opened = await service.context();
            draftLoad.mockResolvedValue({ id: 'review', name: 'Updated review', parameters: [{ name: 'essay', type: 'string', required: true }] } as never);
            await expect(service.run({ essay: 'new' }, 'original', opened!.definitionKey)).rejects.toThrow('Flow changed');
            expect(publish).not.toHaveBeenCalled();
            const updated = await service.context();
            const rerun = await service.run({ essay: 'new' }, 'original', updated!.definitionKey);
            expect(publish).toHaveBeenCalledTimes(1);
            expect(submit.mock.calls[0][0].sendIntent.execution.revision).toBe(4);
            expect(submit.mock.calls[0][0].text).toContain('review@v4');
            expect((await log.readRound('original'))?.flow?.revision).toBe(3);
            revision.mockResolvedValue({ ...updated!.definition, revision: 4 } as never);
            expect(rerun.branchName).not.toBe('main');
            expect(assertCanSubmit).toHaveBeenLastCalledWith('s', true);
            expect((await log.loadManifest()).branches.main).toBe('original');
            expect((await log.readRound('original'))?.flow?.parameters).toEqual({ essay: 'old' });
            expect((await service.context())?.flow.parameters).toEqual({ essay: 'new' });
            await expect(service.run({ essay: 'stale' }, 'original')).rejects.toThrow('changed');
            expect(submit).toHaveBeenCalledTimes(1);
            const saved = await log.loadManifest();
            const current = await service.context();
            submit.mockRejectedValueOnce(new Error('cannot resolve agent'));
            await expect(service.run({ essay: 'retry' }, current!.sourceRoundId)).rejects.toThrow('cannot resolve agent');
            expect(await log.loadManifest()).toEqual(saved);
        } finally { revision.mockRestore(); draftLoad.mockRestore(); publish.mockRestore(); }
    });
});
