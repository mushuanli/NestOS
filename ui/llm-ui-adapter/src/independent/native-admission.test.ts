import {expect, it, vi} from 'vitest';
import type {ConversationControls, ConversationSnapshot} from '@itookit/ui-common';
import {awaitNativeAdmission} from './native-admission';

function host() {
    let state = {instructionQueue: {acceptedIds: [] as string[]}} as ConversationSnapshot;
    const listeners = new Set<() => void>(), release = vi.fn();
    const controls = {snapshot: () => state, subscribe: (listener: () => void) => {
        listeners.add(listener); return () => {listeners.delete(listener); release();};
    }} as ConversationControls;
    return {controls, release, emit(next: Partial<ConversationSnapshot>) {
        state = {...state, ...next}; for (const listener of [...listeners]) listener();
    }};
}

it('settles exact durable admission before its reply and ignores a late rejected transport', async () => {
    const f = host(); let fail!: (error: unknown) => void;
    const start = vi.fn(() => new Promise<ConversationSnapshot>((_resolve, reject) => {fail = reject;}));
    const waiting = awaitNativeAdmission(f.controls, 'original', start); await Promise.resolve();
    f.emit({instructionQueue: {revision: 1, paused: false, acceptedIds: ['original'], items: []}});
    expect((await waiting).instructionQueue?.acceptedIds).toEqual(['original']);
    fail(new Error('Late transport error')); await Promise.resolve();
    expect(start).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
});

it('does not settle from a different operation or a pending receipt', async () => {
    const f = host(); let reply!: (state: ConversationSnapshot) => void;
    const value = {title: 'Transport reply'} as ConversationSnapshot;
    const waiting = awaitNativeAdmission(f.controls, 'original', () => new Promise(resolve => {reply = resolve;}));
    await Promise.resolve(); f.emit({submission: {id: 'other', status: 'accepted'}});
    f.emit({submission: {id: 'original', status: 'pending'}});
    expect(f.release).not.toHaveBeenCalled(); reply(value);
    expect(await waiting).toBe(value); expect(f.release).toHaveBeenCalledOnce();
});

it('does not start another operation when subscription immediately proves existing admission', async () => {
    const release = vi.fn(), start = vi.fn();
    const controls = {snapshot: () => ({submission: {id: 'original', status: 'accepted'}}),
        subscribe: (listener: () => void) => {listener(); return release;}} as unknown as ConversationControls;
    await expect(awaitNativeAdmission(controls, 'original', start)).resolves.toMatchObject({submission: {status: 'accepted'}});
    expect(start).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
});

it('releases the view wait on abort without cancelling or resending the native operation', async () => {
    const f = host(), lifetime = new AbortController(), reason = new Error('View closed');
    let reply!: (state: ConversationSnapshot) => void;
    const start = vi.fn(() => new Promise<ConversationSnapshot>(resolve => {reply = resolve;}));
    const waiting = awaitNativeAdmission(f.controls, 'original', start, lifetime.signal); await Promise.resolve();
    lifetime.abort(reason); await expect(waiting).rejects.toBe(reason);
    reply({title: 'Late'} as ConversationSnapshot); await Promise.resolve();
    expect(start).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
});

it('preserves the original rejection and falls back to the reply without observation ports', async () => {
    const f = host(), reason = new Error('Rejected');
    await expect(awaitNativeAdmission(f.controls, 'original', async () => {throw reason;})).rejects.toBe(reason);
    expect(f.release).toHaveBeenCalledOnce();
    const value = {title: 'Legacy reply'} as ConversationSnapshot;
    await expect(awaitNativeAdmission({} as ConversationControls, 'legacy', async () => value)).resolves.toBe(value);
});

it('retains durable acceptance when observer cleanup and its diagnostic sink fail', async () => {
    const f = host(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {throw new Error('Log sink unavailable');});
    f.release.mockImplementationOnce(() => {throw new Error('PRIVATE observer failure');});
    try {
        const waiting = awaitNativeAdmission(f.controls, 'original', () => new Promise(() => {}));
        f.emit({submission: {id: 'original', status: 'accepted'}});
        await expect(waiting).resolves.toMatchObject({submission: {id: 'original', status: 'accepted'}});
        expect(f.release).toHaveBeenCalledOnce();
    } finally {warning.mockRestore();}
});
