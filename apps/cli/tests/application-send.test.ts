import {expect, it, vi} from 'vitest';
import type {ApplicationClient} from '@itookit/app-contracts/services';
import {SessionCommand} from '@itookit/llm-session/contracts';
import {executeApplicationCommand} from '../src/application-command';

it.each(['completed', 'failed', 'await_signal'])('waits for local session %s before releasing its view', async status => {
    let global!: (event: unknown) => void, local!: (event: unknown) => void, submitted!: () => void;
    const accepted = new Promise<void>(resolve => {submitted = resolve;});
    const dispose = vi.fn(async () => {}), offGlobal = vi.fn(), offLocal = vi.fn();
    const execute = vi.fn(async (name: string) => {
        if (name === SessionCommand.Send) {submitted(); return {accepted: true};}
        return {sessionId: 'session', status: status === 'await_signal' ? 'running' : status};
    });
    const client = {backend: {openSessionView: async () => ({activate: async () => ({}), dispose})},
        services: {commandBus: {execute}, sessionManager: {
            onGlobalEvent: (callback: typeof global) => {global = callback; return offGlobal;},
            onEvent: (callback: typeof local) => {local = callback; return offLocal;}}}} as unknown as ApplicationClient;
    const sending = executeApplicationCommand(client, 'session', ['send', 'session', 'test prompt'], {});
    await accepted;
    expect(dispose).not.toHaveBeenCalled();
    if (status === 'await_signal') local({type: 'await_signal'});
    else global({type: 'session_status_changed', payload: {sessionId: 'session', status}});
    await expect(sending).resolves.toMatchObject({accepted: {accepted: true}, waitingForInput: status === 'await_signal'});
    expect(execute.mock.calls.filter(([name]) => name === SessionCommand.Send)).toHaveLength(1);
    expect(offGlobal).toHaveBeenCalledOnce(); expect(offLocal).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
});
