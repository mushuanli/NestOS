import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@itookit/vfs-core';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {DiagnosticJournal} from '../src/diagnostics/journal';
import {inspectAuthorization} from '../src/projects/authorization-inspection';
import type {RemoteFileSourceProvider, ProjectRemoteMount} from '../src/projects/remote-mounts';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of releases.splice(0).reverse()) await close(); vi.restoreAllMocks();});
const input = {module: 'cells' as const, operation: 'remote.operation', stage: 'root-probe', level: 'error' as const,
    result: 'failure' as const, code: 'EACCES', projectId: 'a', connectionId: 'node'};

it('merges repeated failures across unrelated sources, retains bounded correlations and closes on recovery', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const journal = new DiagnosticJournal();
    const first = journal.record({...input, operationId: 'op-0', requestId: 'req-0', durationMs: 1});
    for (let index = 1; index <= 12; index++) {
        now += 100; journal.record({...input, projectId: 'other'});
        journal.record({...input, operationId: 'op-' + index, requestId: 'req-' + index, durationMs: index + 1});
    }
    const page = await journal.query({projectId: 'a'}), group = page.events[0];
    expect(page.events).toHaveLength(1); expect(group.id).toBe(first.id);
    expect(group).toMatchObject({operationId: 'op-12', requestId: 'req-12', series: {count: 13, firstAt: 1000, lastAt: 2200,
        firstOperationId: 'op-0', firstRequestId: 'req-0', minDurationMs: 1, maxDurationMs: 13, totalDurationMs: 91}});
    expect(group.series!.samples).toHaveLength(5); expect(page.matchingOccurrences).toBe(13);
    now = 2500; journal.record({...input, operation: 'project.connection', result: 'success', level: 'info', code: undefined});
    expect((await journal.query({projectId: 'a'})).events.find(event => event.id === first.id)?.series).toMatchObject({count: 13, endedAt: 2500, ending: 'recovered'});
    now = 3000; journal.record({...input, profileId: 'different'}); journal.record(input);
    expect((await journal.query({projectId: 'a', level: 'error'})).events.map(event => event.series?.count)).toEqual([1, 1, 13]);
    expect((await journal.query({projectId: 'a', startTime: 2100, endTime: 2400})).events).toHaveLength(1);
});

it('splits changed errors and gaps without claiming that a previous failure recovered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const journal = new DiagnosticJournal(); journal.record(input);
    now += 10; journal.record({...input, code: 'ETIMEDOUT'});
    now += 6 * 60 * 1000; journal.record({...input, code: 'ETIMEDOUT'});
    const events = (await journal.query()).events;
    expect(events).toHaveLength(3); expect(events[1].series?.ending).toBe('changed'); expect(events[2].series?.ending).toBe('changed');
});

it('migrates legacy events to individual transactional SeqFile entries and separates restarted series', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web'}); releases.push(() => runtime.dispose());
    await runtime.diagnostics.dispose();
    const fs = await runtime.vfs.openFileSystem('/'), seq = fs.meta.seq!, path = '/var/log/application-diagnostics.seq';
    const oldIndex = JSON.parse((await seq.getEntry(path, 'index'))!);
    await seq.transaction!(async tx => {for (const id of oldIndex.ids) await tx.deleteEntry(path, 'event:' + id); await tx.deleteEntry(path, 'index');});
    const old = [1000, 2000].map((timestamp, index) => ({...input, id: 'legacy-' + index, operationId: 'op-' + index, timestamp, secret: 'PRIVATE_TOKEN'}));
    await seq.setEntry(path, 'events', JSON.stringify(old));
    const journal = new DiagnosticJournal(); await journal.attach(fs); await journal.flush();
    const legacy = (await journal.query()).events[0];
    expect(legacy.series).toMatchObject({count: 2, firstAt: 1000, lastAt: 2000, ending: 'restarted'});
    expect(await seq.getEntry(path, 'events')).toBeNull();
    expect(JSON.parse((await seq.getEntry(path, 'event:' + legacy.id))!).series.count).toBe(2);
    journal.record(input); await journal.dispose();
    const reopened = new DiagnosticJournal(); await reopened.attach(fs); releases.push(() => reopened.dispose());
    const page = await reopened.query(); expect(page.events).toHaveLength(2); expect(page.totalOccurrences).toBe(3);
    const index = JSON.parse((await seq.getEntry(path, 'index'))!); expect(index.version).toBe(2);
    expect(JSON.stringify(page)).not.toContain('PRIVATE_TOKEN');
});

const mount = {alias: 'docs', root: '/', access: 'rw', serverProjectId: 'project', serverProjectRevision: 1,
    authorization: {principalId: 'owner', anonymous: false, revision: 'a'.repeat(64)}} as ProjectRemoteMount;
function provider(roots: Array<{alias: string; access: 'ro' | 'rw'}>, project?: object) {
    const read = vi.fn(async () => project), close = vi.fn(async () => {});
    const source = {projects: () => ({roots: async () => ({roots}), read, close})} as unknown as RemoteFileSourceProvider;
    return {source, read, close};
}
it('distinguishes an ungranted export from a stale binding without attempting to grant or remount', async () => {
    const denied = provider([]), permitted = provider([{alias: 'docs', access: 'ro'}], {access: 'ro', revision: 2,
        authorization: {principalId: 'owner', revision: 'b'.repeat(64)}, capabilities: {fileRead: true, fileWrite: false, run: false, sessionRead: true, sessionControl: false}});
    const result = await inspectAuthorization(denied.source, {endpoint: 'https://private.test', credentialRef: 'private'}, mount);
    expect(result).toMatchObject({reason: 'export-not-granted', exportAccess: 'none', projectAccess: 'denied', code: 'REMOTE_EXPORT_NOT_GRANTED'});
    expect(denied.read).not.toHaveBeenCalled(); expect(denied.close).toHaveBeenCalledOnce();
    const next = await inspectAuthorization(permitted.source, {endpoint: 'https://private.test', credentialRef: 'private'}, mount);
    expect(next).toMatchObject({reason: 'binding-outdated', exportAccess: 'ro', projectAccess: 'ro', projectRevision: 2, principalId: 'owner'});
    expect(permitted.read).toHaveBeenCalledWith('project', undefined); expect(JSON.stringify(next)).not.toContain('private');
});
