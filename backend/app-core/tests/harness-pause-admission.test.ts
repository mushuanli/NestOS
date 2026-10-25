import {expect, it, vi} from 'vitest';
import {sha256HexSync} from '@itookit/common';
import {ExecutionJournal, nativeOperationId} from '../src/projects/harness-execution-journal';
import {driveNativeInteractions} from '../src/projects/harness-execution-interactions';
import type {NativeExecution} from '../src/projects/harness-execution-operations';
import {fixture, interaction, request} from './harness-execution-fixture';

const responseId = 'string:question-1', step = `respond-${sha256HexSync(responseId)}`;
async function prepared() {
    const f = fixture(); interaction(f);
    const journal = new ExecutionJournal(f.state, f.context, request);
    await journal.initialize('service-epoch'); await journal.save({sessionId: 'native-session', turnId: 'native-turn'});
    await f.state.set(`${request.notificationKey}.response.${encodeURIComponent(responseId)}`, {approved: true});
    const run: NativeExecution = {acquired: await f.connections.acquire(), journal, request, signal: f.controller.signal};
    const page = await f.client.eventSnapshot('claude');
    return {...f, run, page};
}

it('fails closed before a new response when durable running admission is unavailable', async () => {
    const f = await prepared(); delete f.state.setIfRunning;
    await expect(driveNativeInteractions(f.run, f.context, f.page)).rejects.toMatchObject({code: 'NATIVE_CONTINUATION_GUARD_UNAVAILABLE'});
    expect(f.run.journal.data.operations[step]).toBeUndefined();
    expect(f.client.respond).not.toHaveBeenCalled(); expect(f.client.operation).not.toHaveBeenCalled();
});

it('retains held responses without journaling admission, logs safely once, and admits the same identity later', async () => {
    const f = await prepared(), original = f.state.setIfRunning!;
    f.state.setIfRunning = vi.fn(async () => undefined);
    await driveNativeInteractions(f.run, f.context, f.page); await driveNativeInteractions(f.run, f.context, f.page);
    expect(f.run.journal.data.operations[step]).toBeUndefined(); expect(f.client.respond).not.toHaveBeenCalled();
    const emitted = vi.mocked(f.context.emit!).mock.calls;
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toMatchObject({type: 'harness:execution', payload: {operation: 'harness.respond', stage: 'admission', outcome: 'held'}});
    expect(JSON.stringify(emitted)).not.toContain(request.prompt); expect(JSON.stringify(emitted)).not.toContain('approved');
    expect(JSON.stringify(emitted)).not.toContain('question-1'); expect(JSON.stringify(emitted)).not.toContain('true');
    f.state.setIfRunning = original;
    await driveNativeInteractions(f.run, f.context, f.page);
    expect(f.client.respond).toHaveBeenCalledOnce(); expect(f.run.journal.data.operations[step]).toMatchObject({outcome: 'committed',
        requestId: nativeOperationId(f.context, step)});
    expect(vi.mocked(f.context.emit!).mock.calls.at(-1)![0]).toMatchObject({payload: {outcome: 'committed'}});
});

it('only reconciles an already admitted pending response even without current running permission', async () => {
    const f = await prepared(), requestId = nativeOperationId(f.context, step);
    await f.run.journal.operation(step, {requestId, outcome: 'pending'});
    f.receipts.set(requestId, {requestId, outcome: 'committed', result: {}}); delete f.state.setIfRunning;
    await driveNativeInteractions(f.run, f.context, f.page);
    expect(f.client.respond).not.toHaveBeenCalled(); expect(f.client.operation).toHaveBeenCalledOnce();
    expect(f.client.operation).toHaveBeenCalledWith('claude', requestId, expect.objectContaining({epoch: 'service-epoch'}));
    expect(f.run.journal.data.operations[step].outcome).toBe('committed');
});

it('keeps an uncertain admitted response pending instead of sending it again', async () => {
    const f = await prepared(), requestId = nativeOperationId(f.context, step);
    await f.run.journal.operation(step, {requestId, outcome: 'pending'});
    f.receipts.set(requestId, {requestId, outcome: 'unknown'});
    await expect(driveNativeInteractions(f.run, f.context, f.page)).rejects.toMatchObject({code: 'NATIVE_OUTCOME_UNKNOWN'});
    expect(f.run.journal.data.operations[step].outcome).toBe('pending'); expect(f.client.respond).not.toHaveBeenCalled();
});
