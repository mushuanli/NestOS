import { expect, it, vi } from 'vitest';
import { createSendBoundary } from '../../../apps/tauri-app/src/log/send-boundary';
import { TauriLLMLogger } from '../../../apps/tauri-app/src/log/tauri-llm-logger';

function recorder() {
    const begun: string[] = [], ended: number[] = [];
    let sequence = 0;
    return { begun, ended, target: { begin: (label: string) => { begun.push(label); return ++sequence; }, end: (id: number) => { ended.push(id); } } };
}

it('brackets one send from the accepted user message to the provider response', () => {
    const { begun, ended, target } = recorder();
    const boundary = createSendBoundary(target);
    boundary.responded();                       // no window yet: nothing to close
    boundary.accepted();
    boundary.accepted();                        // a second append must not nest
    expect(begun).toEqual(['send-to-provider']);
    boundary.responded();
    boundary.responded();
    expect(ended).toEqual([1]);
    boundary.accepted();
    expect(begun).toEqual(['send-to-provider', 'send-to-provider']);
});

it('records a window that ends without a provider response', () => {
    const { begun, ended, target } = recorder();
    const boundary = createSendBoundary(target);
    boundary.accepted();
    boundary.abandoned();
    boundary.abandoned();
    expect(begun).toHaveLength(1);
    expect(ended).toEqual([1]);
});

it('bounds a send that never answers so the next send is still measured', () => {
    vi.useFakeTimers();
    try {
        const { begun, ended, target } = recorder();
        const boundary = createSendBoundary(target, { timeoutMs: 1000 });
        boundary.accepted();
        vi.advanceTimersByTime(1000);
        expect(ended).toEqual([1]);
        boundary.accepted();
        expect(begun).toHaveLength(2);
        boundary.responded();
        expect(ended).toEqual([1, 2]);
        // A closed window leaves no pending timer behind.
        vi.advanceTimersByTime(1000);
        expect(ended).toEqual([1, 2]);
    } finally { vi.useRealTimers(); }
});

it('closes the trace window when the provider answers with headers', () => {
    const logger = new TauriLLMLogger('/root');
    const onResponse = vi.fn();
    logger.onResponse = onResponse;
    logger.logResponse('session', { status: 200, headers: {} });
    expect(onResponse).toHaveBeenCalledWith('session', 200);
    logger.onResponse = undefined;
    logger.logResponse('session', { status: 500, headers: {} });
    expect(onResponse).toHaveBeenCalledTimes(1);
});
