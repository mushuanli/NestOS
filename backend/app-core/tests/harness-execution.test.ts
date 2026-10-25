import { describe, expect, it, vi } from 'vitest';
import { createHarnessExecutionProvider, harnessExecutionJournalKey } from '../src/projects/harness-execution';
import { ExecutionJournal, nativeOperationId } from '../src/projects/harness-execution-journal';
import { complete, fixture, interaction, request } from './harness-execution-fixture';

describe('durable native Harness execution', () => {
    it('reports scoped not-started evidence without acquiring a connection when no original journal exists', async () => {
        const f = fixture();
        expect(await f.make().reconcile(request, f.context)).toEqual({status: 'not-started', evidence: {
            sessionId: f.context.sessionId, taskId: f.context.taskId, effectId: f.context.effectId,
            kind: 'not-started', ref: harnessExecutionJournalKey(f.context),
        }});
        expect(f.connections.acquire).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
    });

    it('observes the original running turn within the recovery budget without creating another turn', async () => {
        const f = fixture(); interaction(f);
        const running = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.client.turn).toHaveBeenCalledOnce());
        f.controller.abort(); await running;
        const recoveryAbort = new AbortController(), eventCount = vi.mocked(f.client.eventSnapshot).mock.calls.length;
        const recovery = f.make().reconcile(request, {...f.context, abortSignal: recoveryAbort.signal});
        try {
            await vi.waitFor(() => expect(vi.mocked(f.client.eventSnapshot).mock.calls.length).toBeGreaterThan(eventCount));
            expect(f.client.turn).toHaveBeenCalledOnce();
        } finally {recoveryAbort.abort();}
        expect(await recovery).toMatchObject({status: 'unknown'});
        expect(f.client.turn).toHaveBeenCalledOnce();
    });
    it('persists each mutation intent before dispatch and saves only matching completed assistant items before returning', async () => {
        const f = fixture();
        vi.mocked(f.client.turn).mockImplementation(async (_profile, _session, _prompt, options) => {
            const journal = f.records.get(harnessExecutionJournalKey(f.context))!.value as any;
            expect(journal.operations.turn).toMatchObject({ outcome: 'pending', requestId: options!.requestId });
            complete(f); return f.committed(options, { turnId: 'native-turn' }) as { turnId: string };
        });
        const result = await f.make().execute(request, f.context);
        expect(result).toEqual({ sessionId: 'native-session', turnId: 'native-turn', text: 'First answer\nSecond answer' });
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).result).toEqual(result);
        expect(f.release).toHaveBeenCalledOnce();
        expect(JSON.stringify(vi.mocked(f.context.emit!).mock.calls)).not.toContain(request.prompt);
        expect(JSON.stringify(vi.mocked(f.context.emit!).mock.calls)).not.toContain('First answer');
    });

    it('reconstructs from a lost turn response by querying its stable receipt without dispatching a second turn', async () => {
        const f = fixture();
        vi.mocked(f.client.turn).mockImplementationOnce(async (_profile, _session, _prompt, options) => {
            f.committed(options, { turnId: 'native-turn' }); complete(f); throw new Error('Connection lost');
        });
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ code: 'NATIVE_OUTCOME_UNKNOWN' });
        const result = await f.make().reconcile(request, { ...f.context, attemptId: 'attempt-2', attemptNumber: 2 });
        expect(result).toMatchObject({ status: 'completed', result: { text: 'First answer\nSecond answer' } });
        expect(f.client.turn).toHaveBeenCalledOnce();
        expect(f.client.operation).toHaveBeenCalledWith('claude', nativeOperationId(f.context, 'turn'), expect.objectContaining({ epoch: 'service-epoch' }));
    });

    it('recovers a committed native result even if the local post-call journal save failed', async () => {
        const f = fixture(), set = f.state.set.bind(f.state);
        let failed = false;
        vi.spyOn(f.state, 'set').mockImplementation(async (key, value, version) => {
            if (!failed && (value as any).operations?.turn?.outcome === 'committed') { failed = true; throw new Error('disk unavailable'); }
            return set(key, value, version);
        });
        complete(f);
        await expect(f.make().execute(request, f.context)).rejects.toThrow('disk unavailable');
        expect(await f.make().reconcile(request, f.context)).toMatchObject({ status: 'completed' });
        expect(f.client.turn).toHaveBeenCalledOnce();
    });

    it('retains an unknown submission as indeterminate and refuses an epoch change without terminal evidence', async () => {
        const f = fixture();
        vi.mocked(f.client.turn).mockImplementationOnce(async () => { throw new Error('lost'); });
        vi.mocked(f.client.operation).mockImplementation(async (_profile, id) => ({ requestId: id, outcome: 'unknown' }));
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ code: 'NATIVE_OUTCOME_UNKNOWN' });
        expect(await f.make().reconcile(request, f.context)).toMatchObject({ status: 'unknown' });
        f.data.epoch = 'replacement';
        expect(await f.make().reconcile(request, f.context)).toMatchObject({ status: 'unknown', code: 'NATIVE_EPOCH_CHANGED' });
        expect(f.client.turn).toHaveBeenCalledOnce();
    });

    it('replays a durable result after restart and epoch replacement without contacting the native service', async () => {
        const f = fixture(); complete(f);
        const result = await f.make().execute(request, f.context);
        f.connections.acquire.mockClear(); f.data.epoch = 'replacement';
        expect(await f.make().reconcile(request, f.context)).toEqual({ status: 'completed', result });
        expect(f.connections.acquire).not.toHaveBeenCalled();
    });

    it('rejects a changed prompt or target on the same durable Effect identity', async () => {
        const f = fixture(); complete(f); await f.make().execute(request, f.context);
        expect(await f.make().reconcile({ ...request, prompt: 'different' }, f.context)).toMatchObject({ status: 'unknown', code: 'JOURNAL_CONFLICT' });
        expect(await f.make().reconcile({ ...request, connection: { ...request.connection, profileId: 'codex' } }, f.context))
            .toMatchObject({ status: 'unknown', code: 'JOURNAL_CONFLICT' });
        expect(f.client.turn).toHaveBeenCalledOnce();
    });

    it('does not infer completion from idle state or a different turn completion', async () => {
        const f = fixture(); f.session.status = 'idle';
        f.push('turn/completed', { threadId: 'native-session', turn: { id: 'other', status: 'completed' } });
        const operation = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.client.eventSnapshot).toHaveBeenCalled());
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).result).toBeUndefined();
        f.controller.abort(); expect(await operation).toBeInstanceOf(Error);
    });

    it('repairs an event gap using exact turn history while refusing an unprovable terminal state', async () => {
        const f = fixture(); f.data.gap = true;
        f.data.history = { session: { ...f.session, status: 'idle', activeTurnId: null }, turns: [{ id: 'native-turn', status: 'completed',
            items: [{ id: 'answer', type: 'agentMessage', text: 'Recovered answer' }] }] };
        expect(await f.make().execute(request, f.context)).toMatchObject({ text: 'Recovered answer' });
        const g = fixture(); g.data.gap = true; g.data.history.session = { ...g.session, status: 'notLoaded', activeTurnId: null };
        await expect(g.make().execute(request, g.context)).rejects.toMatchObject({ code: 'NATIVE_TERMINAL_UNKNOWN' });
    });

    it.each(['failed', 'cancelled', 'interrupted'])('persists %s terminal evidence and never reports success', async status => {
        const f = fixture(); complete(f, status);
        await expect(f.make().execute(request, f.context)).rejects.toMatchObject({ code: status === 'failed' ? 'NATIVE_TURN_FAILED' : 'NATIVE_TURN_CANCELLED' });
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).terminal).toBe(status === 'failed' ? 'failed' : 'cancelled');
    });

    it.each([true, { approved: true }, { decision: 'approve' }, { decision: 'accept' }])('notifies once and maps the explicit approval response %j', async answer => {
        const f = fixture(); interaction(f);
        vi.mocked(f.client.respond).mockImplementation(async (_profile, _id, _answer, options) => { f.committed(options, {}); complete(f); });
        const running = f.make().execute(request, f.context);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        const notification = f.records.get(request.notificationKey)!;
        const id = (notification.value as any).id;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(f.records.get(request.notificationKey)!.version).toBe(1);
        await f.state.set(`${request.notificationKey}.response.${encodeURIComponent(id)}`, answer);
        expect(await running).toMatchObject({ text: 'First answer\nSecond answer' });
        expect(f.client.respond).toHaveBeenCalledWith('claude', 'question-1', { decision: 'accept' }, expect.objectContaining({ epoch: 'service-epoch' }));
    });

    it.each([true, false])('rejects boolean approval %j when its decision is not advertised', async answer => {
        const f = fixture(); interaction(f);
        f.data.requests[0].params!.decisions = [answer ? 'decline' : 'accept'];
        const running = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        const id = (f.records.get(request.notificationKey)!.value as any).id;
        await f.state.set(`${request.notificationKey}.response.${encodeURIComponent(id)}`, answer);
        expect(await running).toMatchObject({ code: 'NATIVE_RESPONSE_INVALID' });
        expect(f.client.respond).not.toHaveBeenCalled();
    });

    it('passes structured input answers unchanged and persists an independent response request identity', async () => {
        const f = fixture(); interaction(f, 'input');
        (f.data.requests[0].params!.questions as any[])[0].multiSelect = true;
        const answer = { answers: { choice: { answers: ['A', 'extra text'] } } };
        vi.mocked(f.client.respond).mockImplementation(async (_profile, _id, _answer, options) => { f.committed(options, {}); complete(f); });
        const running = f.make().execute(request, f.context);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        const id = (f.records.get(request.notificationKey)!.value as any).id;
        await f.state.set(`${request.notificationKey}.response.${encodeURIComponent(id)}`, answer);
        await running;
        expect(vi.mocked(f.client.respond).mock.calls[0][2]).toEqual(answer);
        expect(vi.mocked(f.client.respond).mock.calls[0][3]!.requestId).not.toBe(nativeOperationId(f.context, 'turn'));
    });

    it('requires an explicit approval answer and never forwards ambiguous or payload-only approval', async () => {
        const f = fixture(); interaction(f);
        const running = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        const id = (f.records.get(request.notificationKey)!.value as any).id;
        await f.state.set(`${request.notificationKey}.response.${encodeURIComponent(id)}`, { payload: { approved: true } });
        expect(await running).toMatchObject({ code: 'NATIVE_RESPONSE_INVALID' });
        expect(f.client.respond).not.toHaveBeenCalled();
    });

    it('cancels an active turn awaiting approval using a fresh signal and confirms its matching terminal event', async () => {
        const f = fixture(); interaction(f);
        vi.mocked(f.client.interrupt).mockImplementation(async (_profile, _session, _turn, options) => {
            expect(options!.signal!.aborted).toBe(false); f.committed(options, {}); complete(f, 'cancelled');
        });
        const provider = f.make(), running = provider.execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.records.has(request.notificationKey)).toBe(true));
        f.controller.abort();
        await provider.cancel(request, { ...f.context, sessionState: undefined, grants: [] });
        expect(await running).toBeInstanceOf(Error);
        expect(f.client.interrupt).toHaveBeenCalledOnce();
        expect(f.client.respond).not.toHaveBeenCalled();
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).terminal).toBe('cancelled');
    });

    it('does not equate interrupt acceptance or an unknown interrupt receipt with completed cleanup', async () => {
        const f = fixture();
        const running = f.make().execute(request, f.context).catch(error => error);
        await vi.waitFor(() => expect(f.client.turn).toHaveBeenCalled()); f.controller.abort(); await running;
        await expect(f.make().cancel(request, { ...f.context, sessionState: undefined })).rejects.toBeInstanceOf(Error);
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).terminal).toBeUndefined();
        complete(f, 'interrupted');
        await expect(f.make().cancel(request, { ...f.context, sessionState: undefined })).resolves.toMatchObject({status: 'stopped', cleanup: 'confirmed', evidence: {sessionId: f.context.sessionId, taskId: f.context.taskId, effectId: f.context.effectId}});
        expect(f.client.interrupt).toHaveBeenCalledOnce();
    });

    it('refuses cleanup without durable state access or with another Effect identity', async () => {
        const f = fixture();
        await expect(createHarnessExecutionProvider(f.connections).cancel(request, f.context)).rejects.toMatchObject({ code: 'CLEANUP_STATE_UNAVAILABLE' });
        const journal = new ExecutionJournal(f.state, f.context, request); await journal.initialize('service-epoch');
        const raw = f.records.get(harnessExecutionJournalKey(f.context))!;
        (raw.value as any).owner = ['other-session', 'other-task', 'other-effect'];
        await expect(f.make().cancel(request, f.context)).rejects.toMatchObject({ code: 'JOURNAL_CONFLICT' });
        expect(f.client.interrupt).not.toHaveBeenCalled();
    });

    it('rejects stale journal writers with CAS without mutating the committed receipt', async () => {
        const f = fixture(), first = new ExecutionJournal(f.state, f.context, request), stale = new ExecutionJournal(f.state, f.context, request);
        await first.initialize('service-epoch'); await stale.load(); await first.save({ sessionId: 'native-session' });
        await expect(stale.save({ sessionId: 'different' })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect((f.records.get(harnessExecutionJournalKey(f.context))!.value as any).sessionId).toBe('native-session');
    });
});

it.each([
    [{kind: 'text', name: 'file.txt', content: 'private body'}, [], 'HARNESS_ATTACHMENT_KIND_UNSUPPORTED'],
    [{kind: 'image', name: 'image.png', mimeType: 'image/png', content: 'data:image/png;base64,AQID'}, ['image'], 'HARNESS_ATTACHMENT_MIME_MISMATCH'],
    [{kind: 'text', name: 'file.txt', content: 'x'.repeat(65537)}, ['text'], 'HARNESS_ATTACHMENT_TEXT_LIMIT'],
] as const)('rejects unprepared native attachments before creating a session (%s)', async (attachment, kinds, code) => {
    const f = fixture(); f.profile.capabilities.attachments = [...kinds];
    await expect(f.make().execute({...request, attachments: [attachment]}, f.context)).rejects.toMatchObject({code, executionOutcome: 'not-started'});
    expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
    expect(JSON.stringify((f.context.emit as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('private body');
});

it('binds attachment bytes to the original native operation and rejects changed-content replay', async () => {
    const f = fixture(); f.profile.capabilities.attachments = ['text'];
    vi.mocked(f.client.turn).mockImplementation(async (_profile, _session, _prompt, options) => {
        complete(f); return f.committed(options, {turnId: 'native-turn'}) as {turnId: string};
    });
    const original = {...request, attachments: [{kind: 'text' as const, name: 'file.txt', content: 'original'}]};
    await f.make().execute(original, f.context);
    await expect(f.make().execute({...original, attachments: [{...original.attachments[0], content: 'changed'}]}, f.context))
        .rejects.toMatchObject({code: 'JOURNAL_CONFLICT'});
    expect(f.client.turn).toHaveBeenCalledOnce(); expect(f.client.create).toHaveBeenCalledOnce();
});

it('rejects an oversized UTF-8 prompt before native create or turn and records the preparation stage', async () => {
    const f = fixture();
    await expect(f.make().execute({...request, prompt: '中'.repeat(50000)}, f.context))
        .rejects.toMatchObject({code: 'HARNESS_PROMPT_LIMIT', executionOutcome: 'not-started'});
    expect(f.client.create).not.toHaveBeenCalled(); expect(f.client.turn).not.toHaveBeenCalled();
    expect(f.context.emit).toHaveBeenCalledWith(expect.objectContaining({type: 'harness:execution',
        payload: expect.objectContaining({stage: 'input-preparation', code: 'HARNESS_PROMPT_LIMIT'})}));
});

it('retries a failed connection release before confirming terminal cleanup', async () => {
    const f = fixture(), provider = f.make(); complete(f);
    f.release.mockRejectedValueOnce(new Error('Private transport cleanup failure'));
    await expect(provider.execute(request, f.context)).rejects.toThrow();
    expect(f.release).toHaveBeenCalledOnce();
    expect(await provider.cancel(request, f.context)).toMatchObject({status: 'stopped', cleanup: 'confirmed'});
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.connections.acquire).toHaveBeenCalledOnce(); expect(f.client.turn).toHaveBeenCalledOnce();
});

it('keeps terminal cleanup unconfirmed while its original connection still cannot close', async () => {
    const f = fixture(), provider = f.make(); complete(f);
    f.release.mockRejectedValue(new Error('Private transport cleanup failure'));
    await expect(provider.execute(request, f.context)).rejects.toThrow();
    await expect(provider.cancel(request, f.context)).rejects.toMatchObject({code: 'CLEANUP_CONNECTION_PENDING'});
    expect(f.client.turn).toHaveBeenCalledOnce();
});

it('reconciles a saved result only after retrying the original local connection cleanup', async () => {
    const f = fixture(), provider = f.make(); complete(f);
    f.release.mockRejectedValueOnce(new Error('Transport close unavailable'));
    await expect(provider.execute(request, f.context)).rejects.toMatchObject({code: 'CLEANUP_CONNECTION_PENDING'});
    expect(await provider.reconcile(request, f.context)).toMatchObject({status: 'completed'});
    expect(f.release).toHaveBeenCalledTimes(2); expect(f.client.turn).toHaveBeenCalledOnce();
});

it('does not release another Effect connection when cancelling an unrelated owned journal', async () => {
    const f = fixture(), provider = f.make(); complete(f);
    f.release.mockRejectedValueOnce(new Error('Transport close unavailable'));
    await expect(provider.execute(request, f.context)).rejects.toMatchObject({code: 'CLEANUP_CONNECTION_PENDING'});
    const other = {...f.context, taskId: 'other-task'};
    expect(await provider.cancel(request, other)).toMatchObject({status: 'stopped', evidence: {taskId: 'other-task', kind: 'not-started'}});
    expect(f.release).toHaveBeenCalledOnce();
    await provider.cancel(request, f.context); expect(f.release).toHaveBeenCalledTimes(2);
});
