import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend, createVFS} from '@itookit/vfs-core';
import {DiagnosticJournal} from '../src/diagnostics/journal';
import {initial} from '../src/diagnostics/series';
import {DiagnosticStore} from '../src/diagnostics/store';

afterEach(() => {vi.restoreAllMocks();});
const input = {module: 'cells' as const, operation: 'project.remount', stage: 'commit', projectId: 'a'};

it('replaces each matching start with its terminal result without hiding concurrent operations', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const journal = new DiagnosticJournal();
    const started = journal.record({...input, operationId: 'a', result: 'started', level: 'info'});
    now = 1100; journal.record({...input, operationId: 'b', result: 'started', level: 'info'});
    now = 1200; journal.record({...input, operationId: 'a', result: 'failure', level: 'error', code: 'EACCES', durationMs: 190});
    let page = await journal.query();
    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({id: started.id, operationId: 'a', startedAt: 1000, timestamp: 1200, durationMs: 190, result: 'failure', series: {count: 1}});
    expect(page.events[1]).toMatchObject({operationId: 'b', result: 'started'});
    now = 1300; journal.record({...input, operationId: 'b', result: 'success', level: 'info'});
    page = await journal.query(); expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({operationId: 'b', startedAt: 1100, durationMs: 200, result: 'success'});
    expect(page.totalOccurrences).toBe(2); expect(page.events.every(event => event.result !== 'started')).toBe(true);
    await journal.dispose();
});

it('counts repeated failed attempts once each and retains their start times through persistence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const journal = new DiagnosticJournal(); await journal.attach(fs);
    try {
        for (const operationId of ['one', 'two']) {
            journal.record({...input, operationId, result: 'started', level: 'info'}); await journal.flush();
            now += 100; journal.record({...input, operationId, result: 'failure', level: 'error', code: 'EACCES'}); now += 100;
        }
        const page = await journal.query(); expect(page.events).toHaveLength(1);
        expect(page.events[0]).toMatchObject({operationId: 'two', startedAt: 1200, durationMs: 100, series: {count: 2, firstOperationId: 'one'}});
        await journal.dispose();
        const index = JSON.parse((await fs.meta.seq!.getEntry('/var/log/application-diagnostics.seq', 'index'))!);
        expect(index.ids).toEqual([page.events[0].id]);
        const restored = new DiagnosticJournal(); await restored.attach(fs);
        expect((await restored.query()).events[0]).toMatchObject({startedAt: 1200, series: {count: 2}}); await restored.dispose();
    } finally {await journal.dispose(); await manager.dispose();}
});

it.each(['legacy', 'entries'])('coalesces historical start and result entries from %s storage during loading', async format => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const journal = new DiagnosticJournal();
    try {
        await fs.driver.createFile({parentPath: '/var/log', name: 'application-diagnostics.seq', type: 'seqfile', recursive: true});
        const start = {...input, id: 'start', operationId: 'same', timestamp: 1000, result: 'started' as const, level: 'info' as const};
        const result = {...input, id: 'end', operationId: 'same', timestamp: 1200, result: 'failure' as const, level: 'error' as const, code: 'EACCES'};
        const events = [start, {...result, series: initial(result)}];
        if (format === 'legacy') await fs.meta.seq!.setEntry('/var/log/application-diagnostics.seq', 'events', JSON.stringify(events));
        else {const store = new DiagnosticStore(fs); await store.load(); await store.save(events, new Map(events.map(event => [event.id, JSON.stringify(event)])));}
        await journal.attach(fs); await journal.flush();
        const page = await journal.query(); expect(page.events).toHaveLength(1);
        expect(page.events[0]).toMatchObject({id: 'start', result: 'failure', startedAt: 1000, durationMs: 200});
        expect(await fs.meta.seq!.getEntry('/var/log/application-diagnostics.seq', 'event:end')).toBeNull();
    } finally {await journal.dispose(); await manager.dispose();}
});

it('removes historical starts covered by an aggregated result without losing its occurrence count', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const journal = new DiagnosticJournal();
    try {
        const starts = ['one', 'two'].map((operationId, index) => ({...input, id: operationId, operationId, timestamp: 1000 + index * 200,
            result: 'started' as const, level: 'info' as const}));
        const end = {...input, id: 'end', operationId: 'two', timestamp: 1300, result: 'failure' as const, level: 'error' as const, code: 'EACCES',
            series: {count: 2, firstAt: 1100, lastAt: 1300, firstOperationId: 'one', samples: [{operationId: 'one', timestamp: 1100}, {operationId: 'two', timestamp: 1300}]}};
        const events = [...starts, end], store = new DiagnosticStore(fs); await store.load();
        await store.save(events, new Map(events.map(event => [event.id, JSON.stringify(event)])));
        await journal.attach(fs); await journal.flush();
        expect(await journal.query()).toMatchObject({matchingGroups: 1, totalOccurrences: 2, events: [{operationId: 'two', startedAt: 1200, series: {count: 2}}]});
        expect(await fs.meta.seq!.getEntry('/var/log/application-diagnostics.seq', 'event:one')).toBeNull();
    } finally {await journal.dispose(); await manager.dispose();}
});
