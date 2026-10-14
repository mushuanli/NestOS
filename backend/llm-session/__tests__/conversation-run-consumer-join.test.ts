/**
 * `ConversationRunCoordinator.consume` joins one event consumer per Task. When a host disposes
 * its storage while a run is in flight, `TaskHandle.wait()` rejects with `EACCES`; the join must
 * still settle the in-flight event consumer, otherwise that consumer's own rejection escapes as
 * an unhandled error (observed as `Errors 1 error` in the app-shell matrix run).
 */
import { expect, it, vi } from 'vitest';
import { ConversationRunCoordinator } from '../src/session/conversation-run-coordinator';

function coordinator() {
    return new ConversationRunCoordinator({
        eventBus: { emitGlobal: vi.fn(), emitSession: vi.fn() },
    } as never) as any;
}

function execution() {
    return {
        task: { id: 'run', sessionId: 'session', input: { text: 'go' }, abortController: new AbortController() },
        config: { id: 'agent', name: 'Agent', type: 'agent' },
        roundId: 'round',
        finalize: vi.fn(async () => {}),
        contextFiles: [],
    };
}

it('drains durable child events without publishing them to conversation history', async () => {
    const instance = coordinator();
    const forward = vi.spyOn(instance, 'forwardAgentEvent');
    let drained = false;
    const child = { status: async () => ({ task: { labels: { flowHistory: 'omit' } } }),
        async *events() { yield { type: 'task.event', payload: { type: 'stream:content', delta: 'private child result' } }; drained = true; } };
    await instance.consumeEvents(child, execution(), { output: false }, []);
    expect(drained).toBe(true);
    expect(forward).not.toHaveBeenCalled();
});

it('settles the event consumer when wait() rejects after the storage closes', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
        const storageError = Object.assign(new Error('EACCES: storage closed'), { code: 'EACCES' });
        const consumerError = Object.assign(new Error('EACCES: event stream closed'), { code: 'EACCES' });
        let consumerStarted = false;
        const handle = {
            id: 'task',
            async wait() {
                await new Promise(resolve => setImmediate(resolve));
                throw storageError;
            },
            events: () => ({
                [Symbol.asyncIterator]: async function* () {
                    consumerStarted = true;
                    await new Promise(resolve => setImmediate(resolve));
                    throw consumerError;
                },
            }),
        };

        await expect(coordinator().consume(handle, () => [handle], execution(), (value: unknown) => value,
            { output: false }, []))
            .rejects.toBe(storageError);
        expect(consumerStarted).toBe(true);
        // A rejected consumer must have been observed by the join, not left dangling.
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
}, 15_000);

it('joins existing consumers even when discovering the final task list fails', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const discoveryError = new Error('task list unavailable');
    const handle = {
        id: 'task',
        wait: async () => ({ status: 'succeeded', output: {} }),
        events: () => ({ [Symbol.asyncIterator]: async function* () { await blocked; } }),
    };
    let calls = 0, finished = false;
    const getTasks = () => { if (++calls > 1) throw discoveryError; return [handle]; };
    const consumed = coordinator().consume(handle, getTasks, execution(), (value: unknown) => value,
        { output: false }, []).then(() => { finished = true; }, (error: unknown) => { finished = true; return error; });
    try {
        await vi.waitFor(() => expect(calls).toBeGreaterThan(1));
        expect(finished).toBe(false);
        release();
        expect(await consumed).toBe(discoveryError);
    } finally { release(); await consumed; }
});
