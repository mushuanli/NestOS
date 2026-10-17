import {expect, it, vi} from 'vitest';
import {OpenedViewProjection} from '../src/lifecycle/opened-view';
import type {ApplicationViewEvent, ApplicationServices, ApplicationBackend, OpenedApplicationView} from '@itookit/app-contracts/services';

function fixture(interests?: string[]) {
    let listener!: (event: ApplicationViewEvent) => void, cursor = 10;
    const state = {sessionId: 'session', sessions: [{id: 'message', text: 'initial'}]};
    const update = vi.fn(async (_ids: string[], _revision: number) => {});
    const view = {cursor, connectionInterests: interests, taskAttachmentKey: 'hint', initial: {sessionId: 'session', taskAttachment: {pendingTaskIds: []}, flowInvocations: [], skills: []},
        observation: {getViewCursor: () => cursor, observeView: async (_after: number, next: typeof listener) => {listener = next; return () => {}; }},
        workbench: {connections: {update}}, dispose: vi.fn(async () => {})} as unknown as OpenedApplicationView;
    const source = {sessionManager: {getSnapshot: () => structuredClone(state)}, commandBus: {execute: vi.fn(async () => [])},
        agentService: {}, llmDriver: {}, sessionFiles: {}, sessionRepository: {}, kernel: {kernel: {}}, projects: {favorites: {}, drafts: {}}} as unknown as ApplicationServices;
    const backend = {taskAttachment: vi.fn(async () => ({pendingTaskIds: []}))} as unknown as ApplicationBackend;
    return {view, source, state, backend, update, projection: new OpenedViewProjection(view, source, backend),
        frame(events: ApplicationViewEvent[]) {cursor = events.at(-1)?.sequence ?? cursor; for (const event of events) listener(event);}};
}

it('does not replay stream deltas already included in the hydrated snapshot, then delivers subsequent deltas once', async () => {
    const f = fixture(), received = vi.fn(); await f.projection.start();
    f.projection.services.sessionManager.onEvent(received);
    const event = (sequence: number, delta: string): ApplicationViewEvent => ({sequence, topic: 'session', value: {type: 'stream:content', payload: {delta}}} as ApplicationViewEvent);
    f.state.sessions[0].text = 'initial first second'; f.frame([event(11, ' first'), event(12, ' second')]);
    expect(f.projection.services.sessionManager.getSnapshot().sessions[0]).toEqual(f.state.sessions[0]);
    f.projection.finishHydration(); expect(received).not.toHaveBeenCalled();
    f.frame([event(13, ' third'), event(13, ' third')]); expect(received).toHaveBeenCalledExactlyOnceWith({type: 'stream:content', payload: {delta: ' third'}});
    await f.projection.dispose(); expect(f.view.dispose).toHaveBeenCalledOnce();
});

it('fans out local listeners through one observation and invalidates only the affected Session preloads', async () => {
    const f = fixture(), first = vi.fn(), second = vi.fn(); await f.projection.start();
    f.projection.services.agentService.onChange(first); f.projection.services.agentService.onChange(second);
    f.frame([{sequence: 11, topic: 'kernel', value: {sessionId: 'other', reason: 'structure'}}]);
    expect(await f.projection.backend.taskAttachment('session', 'hint')).toEqual({pendingTaskIds: []});
    f.frame([{sequence: 12, topic: 'agents', value: undefined}]); f.projection.finishHydration();
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    await f.projection.dispose();
});

it('uses the cursor paired with the consumed snapshot instead of a later event cursor', async () => {
    const f = fixture(), received = vi.fn(); await f.projection.start();
    f.projection.services.sessionManager.onEvent(received);
    const snapshot = structuredClone(f.state); snapshot.sessions[0].text += ' first';
    f.view.observation.getSessionBaseline = () => ({cursor: 11, snapshot: snapshot as never});
    f.frame([11, 12].map(sequence => ({sequence, topic: 'session', value: {type: 'stream:content', payload: {delta: String(sequence)}}} as ApplicationViewEvent)));
    expect(f.projection.services.sessionManager.getSnapshot()).toEqual(snapshot);
    f.projection.finishHydration();
    expect(received).toHaveBeenCalledExactlyOnceWith({type: 'stream:content', payload: {delta: '12'}});
    await f.projection.dispose();
});

it('does not consume Session recovery for a different key and stops a subscription that resolves after disposal', async () => {
    const f = fixture();
    await f.projection.backend.taskAttachment('session', 'other-key');
    expect(await f.projection.backend.taskAttachment('session', 'hint')).toEqual({pendingTaskIds: []});

    const stop = vi.fn(); let resolve!: (stop: () => void) => void;
    f.view.observation.observeView = () => new Promise(done => {resolve = done;});
    const started = f.projection.start(); await f.projection.dispose(); resolve(stop); await started;
    expect(stop).toHaveBeenCalledOnce();
});

it('coalesces temporary connection interests while attaching the initial editor', async () => {
    const f = fixture(['project']), view = await f.projection.backend.workbenchView();
    await view.connections!.update([], 1); await view.connections!.update(['project'], 2);
    expect(f.update).not.toHaveBeenCalled();
    f.projection.finishHydration(); expect(f.update).not.toHaveBeenCalled();
    await view.connections!.update(['other'], 3); expect(f.update).toHaveBeenCalledExactlyOnceWith(['other'], 3);
    await f.projection.dispose();
});

it('keeps the latest confirmed connection interests when replies arrive out of order', async () => {
    const f = fixture(['base']), view = await f.projection.backend.workbenchView();
    let release!: () => void, actual = ['base'], latest = -1;
    const gate = new Promise<void>(resolve => {release = resolve;});
    f.update.mockImplementation(async (ids, revision) => {
        if (revision > latest) {actual = ids; latest = revision;}
        if (revision === 1) await gate;
    });
    f.projection.finishHydration();
    const older = view.connections!.update(['first'], 1);
    await view.connections!.update(['second'], 2); release(); await older;
    await view.connections!.update(['first'], 3);
    expect(actual).toEqual(['first']); expect(latest).toBe(3); expect(f.update).toHaveBeenCalledTimes(3);
    await view.connections!.update(['second'], 2); expect(f.update).toHaveBeenCalledTimes(3);
    await f.projection.dispose();
});

it('sends restored initial interests while a different update is still pending', async () => {
    const f = fixture(['base']), view = await f.projection.backend.workbenchView();
    let release!: () => void;
    f.update.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;}));
    f.projection.finishHydration();
    const older = view.connections!.update(['other'], 1);
    await view.connections!.update(['base'], 2);
    expect(f.update).toHaveBeenLastCalledWith(['base'], 2);
    release(); await older; await f.projection.dispose();
});

it('retries unconfirmed interests with a new revision after an update fails', async () => {
    const f = fixture(['base']), view = await f.projection.backend.workbenchView();
    f.update.mockRejectedValueOnce(new Error('Reply lost')); f.projection.finishHydration();
    await expect(view.connections!.update(['other'], 1)).rejects.toThrow('Reply lost');
    await view.connections!.update(['base'], 2);
    expect(f.update).toHaveBeenLastCalledWith(['base'], 2);
    await f.projection.dispose();
});

it('retains the highest interest revision during hydration even if calls arrive out of order', async () => {
    const f = fixture(['base']), view = await f.projection.backend.workbenchView();
    const ids = ['latest']; await view.connections!.update(ids, 3); ids.push('mutated');
    await view.connections!.update(['stale'], 2); f.projection.finishHydration();
    expect(f.update).toHaveBeenCalledExactlyOnceWith(['latest'], 3);
    await f.projection.dispose();
});
