import type {ConversationSnapshot} from '../contracts';
import {afterEach, expect, it, vi} from 'vitest';

import {nativeObservationDiagnostics} from './native-observation-diagnostics';

const logs = vi.hoisted(() => ({info: vi.fn(), warn: vi.fn()}));
vi.mock('@itookit/common', () => ({createModuleLogger: () => logs, randomUUID: () => 'operation'}));
const state: ConversationSnapshot = {sessionId: 'session', title: 'private-title',
    messages: [{id: 'message', role: 'assistant', text: 'private-content'}], requests: [], pending: false,
    gap: false, disconnected: false, canSend: false, canInterrupt: false, canRespond: false};
afterEach(() => {vi.useRealTimers(); vi.resetAllMocks();});

it('bounds streaming logs independently per stage and omits private content', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const diagnose = nativeObservationDiagnostics('conversation'), update = vi.fn();
    diagnose('receive_project', state, update); diagnose('receive_project', state, update);
    diagnose('render_toolbar', state, update);
    expect(update).toHaveBeenCalledTimes(3); expect(logs.info).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain('private');
    expect(logs.info.mock.calls[0][1]).toMatchObject({sessionId: 'session', messageCount: 1, textLength: 15});
    vi.advanceTimersByTime(5_000); diagnose('receive_project', state, update);
    expect(logs.info).toHaveBeenCalledTimes(3);
});

it('reports consecutive failures without leaking errors or changing the thrown exception', () => {
    const diagnose = nativeObservationDiagnostics('conversation'), error = new Error('private-error');
    for (let i = 0; i < 2; i++) expect(() => diagnose('receive_project', state, () => {throw error;})).toThrow(error);
    expect(logs.warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('private');
    logs.warn.mockImplementation(() => {throw new Error('logger unavailable');});
    expect(() => diagnose('receive_project', state, () => {throw error;})).toThrow(error);
});

it('continues updating when the diagnostic logger throws', () => {
    logs.info.mockImplementation(() => {throw new Error('logger unavailable');});
    const update = vi.fn();
    expect(() => nativeObservationDiagnostics('conversation')('receive_project', state, update)).not.toThrow();
    expect(update).toHaveBeenCalledOnce();
});
