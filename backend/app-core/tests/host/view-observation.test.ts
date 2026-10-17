import {expect, it, vi} from 'vitest';
import {ViewObservation} from '../../src/host/view-observation';

function fixture() {
    const sources = new Set<(value?: unknown) => void>(), stop = vi.fn();
    const subscribe = (listener: (value?: unknown) => void) => {sources.add(listener); return () => {sources.delete(listener); stop();};};
    let session!: (value: unknown) => void;
    const services = {sessionRepository: {subscribe}, sessionFiles: {subscribe}, kernel: {kernel: {onChanged: subscribe}},
        sessionManager: {onEvent: (listener: typeof session) => {session = listener; return subscribe(listener);}, onGlobalEvent: subscribe},
        agentService: {onChange: subscribe}};
    return {view: new ViewObservation(services as never), sources, emit: (event: unknown) => session(event)};
}
it('keeps replay payloads detached and stops every source when disposed', async () => {
    const f = fixture(), payload = {type: 'stream:content', payload: {delta: 'first'}};
    f.emit(payload); payload.payload.delta = 'mutated';
    const events: unknown[] = []; const stop = await f.view.observeView(0, event => events.push(event));
    expect(events).toEqual([{sequence: 1, topic: 'session', value: {type: 'stream:content', payload: {delta: 'first'}}}]);
    stop(); await f.view.dispose(); expect(f.sources.size).toBe(0);
    await expect(f.view.observeView(1, () => {})).rejects.toMatchObject({code: 'ECAPABILITY'});
});
it('rejects an unavailable event history instead of silently dropping changes', async () => {
    const f = fixture();
    try {
        for (let index = 0; index < 300; index++) f.emit({type: 'stream:content', payload: {delta: String(index)}});
        await expect(f.view.observeView(0, () => {})).rejects.toMatchObject({code: 'ECAPABILITY'});
        const events: unknown[] = []; await f.view.observeView(299, event => events.push(event)); expect(events).toHaveLength(1);
        expect(f.view.changedSince(0, ['kernel'])).toBe(true);
    } finally {await f.view.dispose();}
});

it('releases earlier sources when registering a later observer fails', () => {
    const stop = vi.fn(), services = {sessionRepository: {subscribe: () => stop},
        sessionFiles: {subscribe: () => {throw new Error('Observer registration failed');}}};
    expect(() => new ViewObservation(services as never)).toThrow('Observer registration failed');
    expect(stop).toHaveBeenCalledOnce();
});
