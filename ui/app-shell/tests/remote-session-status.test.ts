import { createLocalBackendPort } from '@itookit/app-core/host';
import {expect, it, vi} from 'vitest';
import {conversationStatus} from '@itookit/ui-common';
import {t} from '@itookit/common';
import {harnessObservation} from '@itookit/piagent-driver';
import {remoteSessionPath, type ProjectService} from '@itookit/app-core';
import {RemoteSessionStatusView} from '../src/projects/remote-session-status';
it('shares visible observers, updates native titles and refreshes files only when the version changes', () => {
    let callback: (() => void) | undefined, version: string | undefined;
    const stop = vi.fn(), title = vi.fn(), files = vi.fn(), changed = vi.fn();
    const observation = {execution: 'idle', connection: 'online', stale: false, receiptUnknown: false, source: 'list', observedAt: Date.now()};
    const status = {subscribe: vi.fn((_id: string, listener: () => void) => {callback = listener; return stop;}), get: () => observation,
        record: () => ({title: 'Native title'}), fileVersion: () => version};
    const projects = {remoteMounts: {sessionStatus: status, list: () => [{at: '/', serverProjectId: 'native'}]}} as unknown as ProjectService;
    const view = new RemoteSessionStatusView(createLocalBackendPort().harnessObservation, projects, changed, vi.fn(), files, title), tab = remoteSessionPath('/P', 'codex', 's');
    view.project('project'); view.attach(tab, 'project'); expect(status.subscribe).toHaveBeenCalledOnce();
    callback!(); expect(title).toHaveBeenCalledWith(tab, 'Native title'); expect(files).not.toHaveBeenCalled();
    version = 'codex:event:2'; callback!(); callback!(); expect(files).toHaveBeenCalledExactlyOnceWith('project');
    version = 'codex:event:3'; callback!(); expect(files).toHaveBeenCalledTimes(2);
    view.setVisible(false); expect(stop).toHaveBeenCalledOnce(); view.setVisible(true); expect(status.subscribe).toHaveBeenCalledTimes(2);
    callback!(); expect(files).toHaveBeenCalledTimes(2); view.destroy(); expect(stop).toHaveBeenCalledTimes(2);
});

it('renders explicit native ready, working and waiting states while keeping external activity unknown', () => {
    const native = {id: 's', title: 'S', cwd: '/workspace', updatedAt: null, resumable: true};
    expect(conversationStatus(harnessObservation({...native, status: 'idle'})).text).toBe(t('harness.state.idle'));
    expect(conversationStatus(harnessObservation({...native, status: 'active'})).text).toBe(t('harness.state.running'));
    expect(conversationStatus(harnessObservation({...native, status: 'active'}, [{kind: 'approval'}])).text).toBe(t('harness.state.waiting-approval'));
    expect(conversationStatus(harnessObservation({...native, status: 'active'}, [{kind: 'input'}])).text).toBe(t('harness.state.waiting-input'));
    const external = harnessObservation({...native, status: 'notLoaded', owned: false});
    expect(external.execution).toBe('unknown'); expect(conversationStatus(external).text).toBe(t('harness.state.unloaded'));
    expect(conversationStatus({...external, connection: 'offline'}).text).toBe(t('harness.state.offline'));
});

it('uses each project identity for loaded sessions in the all-project view', () => {
    const base = {id: 'same', title: 'S', cwd: '/workspace', updatedAt: null, resumable: true};
    const observations = {a: harnessObservation({...base, status: 'active'}, [{kind: 'approval'}]), b: harnessObservation({...base, status: 'idle'})};
    const status = {subscribe: vi.fn(() => vi.fn()), get: vi.fn((id: 'a' | 'b') => observations[id]), record: () => undefined};
    const projects = {remoteMounts: {sessionStatus: status, list: () => [{at: '/', serverProjectId: 'native'}]}} as unknown as ProjectService;
    const view = new RemoteSessionStatusView(createLocalBackendPort().harnessObservation, projects, vi.fn(), vi.fn());
    const session = (folder: string) => ({id: remoteSessionPath(folder, 'codex', 'same'), metadata: {custom: {remoteStatus: 'notLoaded', remoteObservedAt: Date.now()}}});
    const rows = view.items([{id: '/folder:A', metadata: {custom: {projectId: 'a'}}, children: [session('/A')]},
        {id: '/folder:B', metadata: {custom: {projectId: 'b'}}, children: [session('/B')]}] as never);
    expect(rows[0].children![0].presentation!.badges![0]).toContain(t('harness.state.waiting-approval'));
    expect(rows[1].children![0].presentation!.badges![0]).toContain(t('harness.state.idle'));
    expect(status.subscribe.mock.calls.map(([id]) => id)).toEqual(['a', 'b']); view.destroy();
});

it('uses the two-minute window only for presentation, with native and offline states taking priority', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    const observation = harnessObservation({id: 's', title: 'S', cwd: null, status: 'notLoaded', updatedAt: now - 120_000, resumable: true});
    const original = {...observation};
    const view = conversationStatus(observation, now);
    expect(view.text).toBe(t('harness.activity.recent'));
    expect(view.indicator).toBe('idle'); expect(view.refreshAt).toBe(now + 1);
    expect(view.tooltip).toContain(t('harness.activity.explanation'));
    expect(conversationStatus(observation, now + 1).text).toBe(t('harness.activity.updated', {time: new Date(observation.updatedAt!).toLocaleString()}));
    expect(conversationStatus({...observation, stale: true}, now).text).toBe(t('harness.activity.recent'));
    for (const execution of ['idle', 'running', 'waiting-approval', 'waiting-input'] as const)
        expect(conversationStatus({...observation, execution}, now).text).toBe(t(`harness.state.${execution}`));
    expect(conversationStatus({...observation, nativeError: true, stale: true}, now).text).toBe(t('harness.state.error'));
    expect(conversationStatus({...observation, connection: 'offline'}, now).text).toBe(t('harness.state.offline'));
    for (const updatedAt of [null, undefined, 0, -1, NaN, Infinity])
        expect(conversationStatus({...observation, updatedAt}, now).text).toBe(t('harness.state.unloaded'));
    expect(conversationStatus({...observation, updatedAt: now + 1}, now).refreshAt).toBeUndefined();
    expect(conversationStatus({...observation, updatedAt: now + 1}, now).text).not.toBe(t('harness.activity.recent'));
    expect(observation).toEqual(original);
    expect(observation).toMatchObject({execution: 'unknown', canInterrupt: false, canRespond: false});
});

it('expires inferred tree and tab hints without a server event and releases refresh timers when hidden or destroyed', () => {
    vi.useFakeTimers();
    try {
        const now = Date.parse('2026-10-09T12:00:00Z'); vi.setSystemTime(now);
        const observation = harnessObservation({id: 's', title: 'S', cwd: null, status: 'notLoaded', updatedAt: now - 119_000, resumable: true});
        let callback: (() => void) | undefined;
        const status = {subscribe: vi.fn((_id: string, listener: () => void) => {callback = listener; return vi.fn();}), get: () => observation, record: () => undefined, fileVersion: () => undefined};
        const projects = {remoteMounts: {sessionStatus: status, list: () => [{at: '/', serverProjectId: 'native'}]}} as unknown as ProjectService;
        const changed = vi.fn(), tabStatus = vi.fn();
        const view = new RemoteSessionStatusView(createLocalBackendPort().harnessObservation, projects, changed, tabStatus);
        const tab = remoteSessionPath('/P', 'codex', 's'); view.project('project'); view.attach(tab, 'project');
        const items = [{id: tab, metadata: {lastModified: new Date(now - 119_000).toISOString(), custom: {remoteStatus: 'notLoaded'}}}];
        expect(view.items(items as never)[0].presentation!.badges![0]).toContain(t('harness.activity.recent')); callback!();
        expect(vi.getTimerCount()).toBe(1); changed.mockClear();
        vi.advanceTimersByTime(1000); expect(changed).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1); expect(changed).toHaveBeenCalledOnce();
        expect(tabStatus.mock.lastCall![2]).toContain(t('harness.activity.updated', {time: new Date(observation.updatedAt!).toLocaleString()}));
        expect(view.items(items as never)[0].presentation!.badges![0]).toContain(t('harness.activity.updated', {time: new Date(observation.updatedAt!).toLocaleString()}));
        expect(vi.getTimerCount()).toBe(0);
        observation.updatedAt = Date.now(); view.items(items as never); expect(vi.getTimerCount()).toBe(1);
        view.setVisible(false); expect(vi.getTimerCount()).toBe(0);
        view.setVisible(true); expect(vi.getTimerCount()).toBe(1);
        view.destroy(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
});

it('uses native modification time from unopened tree rows when no observer snapshot exists', () => {
    const view = new RemoteSessionStatusView(createLocalBackendPort().harnessObservation, undefined, vi.fn(), vi.fn());
    const items = [{id: remoteSessionPath('/P', 'codex', 's'), metadata: {lastModified: new Date().toISOString(), custom: {remoteStatus: 'notLoaded'}}}];
    expect(view.items(items as never)[0].presentation!.badges![0]).toContain(t('harness.activity.recent'));
    view.destroy();
});
