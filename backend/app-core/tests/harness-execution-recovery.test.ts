import { describe, expect, it, vi } from 'vitest';
import { harnessExecutionJournalKey } from '../src/projects/harness-execution';
import { nativeOperationId } from '../src/projects/harness-execution-journal';
import { complete, fixture, interaction, request } from './harness-execution-fixture';

describe('native Harness history and interruption recovery', () => {
    it('collects flat paged history after terminal and excludes other turns and threads', async () => {
        const f = fixture();
        f.push('turn/completed', { threadId: 'native-session', turn: { id: 'native-turn', status: 'completed' } });
        vi.mocked(f.client.read).mockImplementation(async (_profile, _session, options) => ({ session: f.session,
            nextCursor: options?.cursor ? null : 'older', turns: options?.cursor ? [
                { id: 'old', type: 'agentMessage', turnId: 'other-turn', text: 'excluded' },
                { id: 'other', type: 'agentMessage', turnId: 'native-turn', threadId: 'other-session', text: 'excluded' },
                { id: 'first', type: 'agentMessage', turnId: 'native-turn', text: 'Earlier text' },
            ] : [{ id: 'second', type: 'agentMessage', turnId: 'native-turn', content: [{ text: 'Later text' }] }],
        }));
        expect(await f.make().execute(request, f.context)).toMatchObject({ text: 'Earlier text\nLater text' });
        expect(f.client.read).toHaveBeenCalledTimes(2);
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).outputChecked).toBe(true);
    });

    it('never treats a completed flat user item whose id equals turnId as terminal evidence', async () => {
        const f = fixture(); f.data.gap = true;
        f.data.history = { session: { ...f.session, status: 'idle', activeTurnId: null }, turns: [
            { id: 'native-turn', turnId: 'native-turn', type: 'userMessage', status: 'completed', content: [] },
            { id: 'answer', turnId: 'native-turn', type: 'agentMessage', status: 'completed', text: 'Partial answer' },
        ] };
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ code: 'NATIVE_TERMINAL_UNKNOWN' });
        const saved = f.records.get(harnessExecutionJournalKey(f.context))!.value as any;
        expect(saved.terminal).toBeUndefined(); expect(saved.result).toBeUndefined();
    });

    it('uses history for text that becomes available during the terminal output read', async () => {
        const f = fixture();
        f.push('turn/completed', { threadId: 'native-session', turn: { id: 'native-turn', status: 'completed' } });
        vi.mocked(f.client.read).mockImplementationOnce(async () => {
            f.push('item/completed', { threadId: 'native-session', turnId: 'native-turn', item: { id: 'late', type: 'agentMessage', text: 'Late answer' } });
            return { ...f.data.history, turns: [{ id: 'native-turn', items: [{ id: 'late', type: 'agentMessage', text: 'Late answer' }] }] };
        });
        expect(await f.make().execute(request, f.context)).toMatchObject({ text: 'Late answer' });
    });

    it('uses the complete history text when an earlier same-id completion event carried empty text', async () => {
        const f = fixture();
        f.push('item/completed', { threadId: 'native-session', turnId: 'native-turn', item: { id: 'answer', type: 'agentMessage', text: '' } });
        f.push('turn/completed', { threadId: 'native-session', turn: { id: 'native-turn', status: 'completed' } });
        f.data.history.turns = [{ id: 'native-turn', items: [{ id: 'answer', type: 'agentMessage', text: 'Authoritative answer' }] }];
        expect(await f.make().execute(request, f.context)).toMatchObject({ text: 'Authoritative answer' });
    });

    it.each(['CLAUDE_SESSION_LIMIT', 'HARNESS_REQUEST_NOT_STARTED'])('retains the safe native rejection category %s', async code => {
        const f = fixture();
        vi.mocked(f.client.create).mockRejectedValueOnce(Object.assign(new Error('Sensitive detail'), { outcome: 'not-committed', code }));
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ code });
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).operations.create.code).toBe(code);
        expect(JSON.stringify(vi.mocked(f.context.emit!).mock.calls)).not.toContain('Sensitive detail');
    });

    it.each(['create', 'turn'] as const)('classifies %s as not started only after a durable not-committed receipt', async step => {
        const f = fixture();
        vi.mocked(f.client[step]).mockRejectedValueOnce(Object.assign(new Error('Rejected'), { outcome: 'not-committed', code: 'NATIVE_REJECTED' }));
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ code: 'NATIVE_REJECTED', executionOutcome: 'not-started' });
        const data = f.records.get(harnessExecutionJournalKey(f.context))!.value as any;
        expect(data.operations[step].outcome).toBe('not-committed'); expect(data.turnId).toBeUndefined();
    });

    it('does not classify a rejected interaction response as an unstarted native turn', async () => {
        const f = fixture(); interaction(f);
        vi.mocked(f.client.respond).mockRejectedValueOnce(Object.assign(new Error('Rejected'), { outcome: 'not-committed', code: 'NATIVE_REJECTED' }));
        const running = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        await f.state.set(`${request.notificationKey}.response.${encodeURIComponent('string:question-1')}`, { approved: true });
        const error = await running;
        expect(error.code).toBe('NATIVE_REJECTED'); expect(error.executionOutcome).toBeUndefined();
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).turnId).toBe('native-turn');
    });

    it.each(['failed', 'cancelled', 'interrupted'])('rethrows persisted %s terminal evidence during reconciliation', async status => {
        const f = fixture(); complete(f, status);
        const code = status === 'failed' ? 'NATIVE_TURN_FAILED' : 'NATIVE_TURN_CANCELLED';
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ code });
        f.connections.acquire.mockClear();
        await expect(f.make().reconcile(request, f.context)).rejects.toMatchObject({ code });
        expect(f.connections.acquire).not.toHaveBeenCalled(); expect(f.client.turn).toHaveBeenCalledOnce();
    });

    it('rethrows a persisted not-started outcome without resubmitting a rejected native mutation', async () => {
        const f = fixture();
        vi.mocked(f.client.create).mockRejectedValueOnce(Object.assign(new Error('Rejected'), { outcome: 'not-committed', code: 'CLAUDE_SESSION_LIMIT' }));
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ executionOutcome: 'not-started' });
        await expect(f.make().reconcile(request, f.context)).rejects.toMatchObject({ code: 'CLAUDE_SESSION_LIMIT', executionOutcome: 'not-started' });
        expect(f.client.create).toHaveBeenCalledOnce(); expect(f.client.turn).not.toHaveBeenCalled();
    });

    it('recovers saved terminal evidence after a failed output read without resubmitting the turn', async () => {
        const f = fixture(); complete(f);
        vi.mocked(f.client.read).mockRejectedValueOnce(new Error('history disconnected'));
        await expect(f.make().execute(request, f.context)).rejects.toThrow('history disconnected');
        expect(await f.make().reconcile(request, f.context)).toMatchObject({ status: 'completed', result: { text: 'First answer\nSecond answer' } });
        expect(f.client.turn).toHaveBeenCalledOnce();
    });

    it('retains saved checked output across an epoch change when the final result write failed', async () => {
        const f = fixture(), set = f.state.set.bind(f.state); complete(f);
        vi.spyOn(f.state, 'set').mockImplementationOnce(set);
        vi.spyOn(f.state, 'set').mockImplementation(async (key, value, revision) => {
            if ((value as any).result) throw new Error('result write failed');
            return set(key, value, revision);
        });
        await expect(f.make().execute(request, f.context)).rejects.toThrow('result write failed');
        vi.mocked(f.state.set).mockImplementation(set); f.data.epoch = 'replacement'; f.connections.acquire.mockClear();
        expect(await f.make().reconcile(request, f.context)).toMatchObject({ status: 'completed' });
        expect(f.connections.acquire).not.toHaveBeenCalled();
    });

    it('retains an unknown interrupt receipt without resending, then accepts exact terminal evidence', async () => {
        const f = fixture(); interaction(f);
        const running = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        f.controller.abort(); await running;
        vi.mocked(f.client.interrupt).mockRejectedValueOnce(new Error('lost interrupt response'));
        await expect(f.make().cancel(request, f.context)).rejects.toMatchObject({ code: 'NATIVE_OUTCOME_UNKNOWN' });
        f.receipts.set(nativeOperationId(f.context, 'interrupt'), { requestId: nativeOperationId(f.context, 'interrupt'), outcome: 'unknown' });
        await expect(f.make().cancel(request, f.context)).rejects.toMatchObject({ code: 'NATIVE_OUTCOME_UNKNOWN' });
        expect(f.client.interrupt).toHaveBeenCalledOnce(); complete(f, 'cancelled');
        await expect(f.make().cancel(request, f.context)).resolves.toMatchObject({status: 'stopped', cleanup: 'confirmed', evidence: {sessionId: f.context.sessionId, taskId: f.context.taskId, effectId: f.context.effectId}});
    });

    it('confirms a pre-dispatch abort only after the native receipt fences the missing turn', async () => {
        const f = fixture(), set = f.state.set.bind(f.state);
        vi.spyOn(f.state, 'set').mockImplementation(async (key, value, version) => {
            const result = await set(key, value, version);
            if ((value as any).operations?.turn?.outcome === 'pending') f.controller.abort();
            return result;
        });
        await expect(f.make().execute(request, f.context)).rejects.toBeInstanceOf(Error);
        await expect(f.make().cancel(request, { ...f.context, sessionState: undefined })).resolves.toMatchObject({status: 'stopped', cleanup: 'confirmed', evidence: {sessionId: f.context.sessionId, taskId: f.context.taskId, effectId: f.context.effectId}});
        expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.interrupt).not.toHaveBeenCalled();
        expect(f.client.operation).toHaveBeenCalledWith('claude', nativeOperationId(f.context, 'turn'), expect.objectContaining({ epoch: 'service-epoch' }));
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).operations.turn.outcome).toBe('not-committed');
    });

    it('does not issue an interrupt against a replacement service epoch', async () => {
        const f = fixture();
        const running = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.client.turn).toHaveBeenCalled()); f.controller.abort(); await running;
        f.data.epoch = 'replacement';
        await expect(f.make().cancel(request, f.context)).rejects.toMatchObject({ code: 'NATIVE_EPOCH_CHANGED' });
        expect(f.client.interrupt).not.toHaveBeenCalled();
    });

    it('fails closed on a profile disconnect without a session id', async () => {
        const f = fixture(); f.push('harness/disconnected', {});
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ code: 'NATIVE_DISCONNECTED' });
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).result).toBeUndefined();
    });

    it.each([false, { approved: false }, { decision: 'deny' }, { decision: 'decline' }])('maps explicit refusal %j only to an advertised refusal', async answer => {
        const f = fixture(); interaction(f);
        vi.mocked(f.client.respond).mockImplementation(async (_profile, _id, _answer, options) => { f.committed(options, {}); complete(f); });
        const running = f.make().execute(request, f.context);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        await f.state.set(`${request.notificationKey}.response.${encodeURIComponent('string:question-1')}`, answer);
        await running;
        expect(vi.mocked(f.client.respond).mock.calls[0][2]).toEqual({ decision: 'decline' });
    });

    it('rejects contradictory explicit approval choices', async () => {
        const f = fixture(); interaction(f);
        const running = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        await f.state.set(`${request.notificationKey}.response.${encodeURIComponent('string:question-1')}`, { approved: false, decision: 'approve' });
        expect(await running).toMatchObject({ code: 'NATIVE_RESPONSE_CONFLICT' }); expect(f.client.respond).not.toHaveBeenCalled();
    });
});
