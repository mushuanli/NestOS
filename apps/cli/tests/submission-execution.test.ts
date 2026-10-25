import {expect, it, vi} from 'vitest';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import {SessionCommand, type SubmissionRequest} from '@itookit/llm-session/contracts';
import {watchSubmissionExecution} from '../src/submission-execution';

function setup() {
    const request: SubmissionRequest = {expectedSessionId: 'session', target: {kind: 'flow', id: 'worker'}, source: {kind: 'arguments', value: {}},
        submission: {id: 'own-call', source: {kind: 'conversation', ownerId: 'session', id: 'own-call'}}};
    const round = {id: 'own-call', sessionId: 'session', submission: request.submission, status: 'running', executions: [{taskId: 'own-root', role: 'primary'}]};
    const readDocument = vi.fn(async () => JSON.stringify(round)), pending = vi.fn(async (): Promise<any[]> => []), stop = vi.fn();
    let global!: (value: unknown) => void, local!: (value: unknown) => void;
    const execute = vi.fn(async () => ({sessionId: 'session', paused: true, items: [{id: 'own-call', state: 'pending'}]}));
    const client = {services: {sessionRepository: {readDocument}, commandBus: {execute}, kernel: {kernel: {listSessionPendingInteractionTasks: pending}}, sessionManager: {
        onGlobalEvent: (callback: typeof global) => {global = callback; return stop;}, onEvent: (callback: typeof local) => {local = callback; return stop;}}}} as unknown as ApplicationClient;
    const watching = watchSubmissionExecution(client, request);
    return {watching, readDocument, pending, execute, stop, round, changed: () => global({type: 'session_status_changed', payload: {sessionId: 'session', status: 'completed'}}),
        signal: () => local({type: 'await_signal'})};
}

it('ignores unrelated completion and approvals until the submitted root has its own pending interaction', async () => {
    const f = setup(); let finished = false;
    const waiting = f.watching.wait().then(state => {finished = true; return state;});
    try {
        await vi.waitFor(() => expect(f.readDocument).toHaveBeenCalledOnce());
        f.pending.mockResolvedValue([{id: 'other-child', rootTaskId: 'other-root', interactions: {input: {status: 'pending'}}}]);
        f.changed(); f.signal(); await vi.waitFor(() => expect(f.readDocument.mock.calls.length).toBeGreaterThan(1));
        expect(finished).toBe(false);
        f.pending.mockResolvedValue([{id: 'own-child', rootTaskId: 'own-root', interactions: {input: {status: 'pending'}}}]);
        f.signal(); expect(await waiting).toMatchObject({status: 'running', rootTaskId: 'own-root', waitingForInput: true});
    } finally {f.watching.dispose();}
    expect(f.stop).toHaveBeenCalledTimes(2);
});

it('returns paused durable queue admission without claiming execution completion', async () => {
    const f = setup(); f.readDocument.mockResolvedValue('');
    try {expect(await f.watching.wait()).toMatchObject({status: 'queued', waitingForDispatch: true, waitingForInput: false});}
    finally {f.watching.dispose();}
    expect(f.execute).toHaveBeenCalledExactlyOnceWith(SessionCommand.GetInstructionQueue);
});

it('rejects a history identity conflict even if another call has a terminal result', async () => {
    const f = setup(); f.round.id = 'other-call'; f.round.status = 'completed';
    try {await expect(f.watching.wait()).rejects.toMatchObject({code: 'CLI_CALL_HISTORY_CONFLICT'});}
    finally {f.watching.dispose();}
    expect(f.pending).not.toHaveBeenCalled();
});
