import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {collectionExecutor} from '@itookit/app-contracts';
import {buildTool, TaskListTool} from '@itookit/tools';
import {acquireCollectionFiles} from '../src/digital-twin/collection-files';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
const target = {kind: 'tool' as const, id: 'fixture.collect', version: '1', digest: 'fixed'};

it('scopes scanner output to a subdirectory and rejects sibling and parent access', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    const files = acquireCollectionFiles(fs, 'scoped', {target, destination: 'emails', directory: 'provider/account'}, async () => {});
    cleanup.push(files.release);
    await files.vfs.writeFile('message.email', 'fixture');
    expect(await fs.driver.readContent('/home/admin/emails/provider/account/message.email', {encoding: 'utf-8'})).toBe('fixture');
    await expect(files.vfs.writeFile('../other/message.email', 'denied')).rejects.toThrow();
    await expect(files.vfs.readFile('/home/admin/emails/provider/other/message.email')).rejects.toThrow();
    for (const directory of ['../escape', '/absolute', 'a/../b', 'a\\b', '.private', 'a//b', 'a/'])
        expect(() => collectionExecutor({target, destination: 'emails', directory})).toThrow('TWIN_COLLECTION_DIRECTORY_INVALID');
});

it('uses an explicitly authorized project source without exposing another project or folder', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/project-files'); let allowed = true;
    const files = acquireCollectionFiles(fs, 'project-scoped', {target, projectId: 'sample', directory: 'reports'}, async () => {
        if (!allowed) throw new Error('TWIN_COLLECTION_PROJECT_READ_ONLY');
    }, '/'); cleanup.push(files.release);
    await files.vfs.writeFile('result.md', 'fixture');
    expect(await fs.driver.readContent('/reports/result.md', {encoding: 'utf-8'})).toBe('fixture');
    await expect(files.vfs.writeFile('../elsewhere/result.md', 'denied')).rejects.toThrow();
    allowed = false; await expect(files.vfs.writeFile('late.md', 'denied')).rejects.toThrow('TWIN_COLLECTION_PROJECT_READ_ONLY');
    expect(() => collectionExecutor({target, projectId: 'sample', destination: 'emails'})).toThrow('TWIN_COLLECTION_DESTINATION_INVALID');
});

it.each(['/profiles/first', '/data/second'])('maps only the selected logical workspace beneath a variable data root: %s', async root => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem(root);
    let allowed = true;
    const files = acquireCollectionFiles(fs, 'collector', {target, destination: 'emails'}, async () => {
        if (!allowed) throw new Error('TWIN_SCAN_PLAN_STALE');
    }); cleanup.push(files.release);
    await files.vfs.writeFile('imports/mail/account/mail/default/item.email', 'fixture');
    const global = await manager.openFileSystem('/');
    expect(await global.driver.readContent(root + '/home/admin/emails/imports/mail/account/mail/default/item.email', {encoding: 'utf-8'})).toBe('fixture');
    await expect(files.vfs.writeFile('/home/admin/notes/escape.md', 'denied')).rejects.toThrow();
    await expect(files.vfs.writeFile('../notes/escape.md', 'denied')).rejects.toThrow();
    allowed = false;
    await expect(files.vfs.writeFile('later.email', 'denied')).rejects.toThrow('TWIN_SCAN_PLAN_STALE');
    await expect(files.vfs.readFile('imports/mail/account/mail/default/item.email')).rejects.toThrow('TWIN_SCAN_PLAN_STALE');
});

it('isolates calendar collection from mail and other accounts', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    const files = acquireCollectionFiles(fs, 'calendar-collector', {target, destination: 'calendar'}, async () => {});
    cleanup.push(files.release);
    await files.vfs.writeFile('imports/calendar/account-a/calendar/primary/event.md', 'calendar material');
    expect(await fs.driver.readContent('/home/admin/calendar/imports/calendar/account-a/calendar/primary/event.md', {encoding: 'utf-8'})).toBe('calendar material');
    expect(await fs.driver.exists('/home/admin/emails/imports/calendar/account-a/calendar/primary/event.md')).toBe(false);
    await expect(files.vfs.writeFile('../emails/escape.md', 'denied')).rejects.toThrow();
});

it('rejects arbitrary host paths and Flow destinations instead of broadening a saved grant', () => {
    for (const destination of ['../../etc', '/home/li/nestos', 'private', 'emails/../notes', null])
        expect(() => collectionExecutor({target, destination} as any)).toThrow('TWIN_COLLECTION_DESTINATION_INVALID');
    expect(() => collectionExecutor({target: {...target, kind: 'flow'}, destination: 'emails'})).toThrow('TWIN_COLLECTION_DESTINATION_INVALID');
    expect(collectionExecutor({target})).toEqual({target});
});

it('uses the saved scanner destination across durable batches and isolates it from its project', async () => {
    const calls: string[] = [];
    const tool = buildTool({name: target.id, version: '1', inputSchema: TaskListTool.inputSchema,
        async description() {return 'Write fixture material';}, async prompt() {return '';},
        async call(_args, context) {
            calls.push(context.cwd!);
            const path = 'imports/mail/account/mail/default/.sync.json';
            let count = 0;
            try {count = JSON.parse(await context.vfs!.readFile(path)).count;} catch (error) {if ((error as any).code !== 'ENOENT') throw error;}
            await context.vfs!.writeFile('imports/mail/account/mail/default/item.email', 'fixture material');
            await context.vfs!.writeFile(path, JSON.stringify({count: ++count}));
            await expect(context.vfs!.writeFile('/home/admin/notes/escape.md', 'denied')).rejects.toThrow();
            return {data: {collection: {version: 1, complete: true, processed: count}}};
        },
        mapToolResultToToolResultBlockParam(data, id) {return {type: 'tool_result', tool_use_id: id, content: JSON.stringify(data)};}});
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false,
        kernelPlatform: {additionalTools: [tool]}}); cleanup.push(() => runtime.dispose());
    const twin = runtime.digitalTwin!, selected = (await twin.collectionTools()).find(item => item.target.id === tool.name)!.target;
    const plan = await twin.saveScanRule(null, null, {name: 'Mail destination', collection: {target: selected, destination: 'emails'}, mode: 'collect',
        include: [], exclude: [], intervalMinutes: 30, enabled: true, trigger: 'manual'});
    for (let batch = 0; batch < 2; batch++) await twin.waitScanRun(await twin.runScanPlan(plan));
    expect(calls).toEqual(['/workspace', '/workspace']);
    const fs = await runtime.vfs.openFileSystem('/');
    expect(await fs.driver.readContent('/home/admin/emails/imports/mail/account/mail/default/item.email', {encoding: 'utf-8'})).toBe('fixture material');
    expect(JSON.parse(await fs.driver.readContent('/home/admin/emails/imports/mail/account/mail/default/.sync.json', {encoding: 'utf-8'})).count).toBe(2);
    expect(await fs.driver.exists('/home/admin/notes/escape.md')).toBe(false);
    expect((await twin.snapshot()).scans.runs.every(run => run.data.state === 'succeeded' && run.data.collection?.destination === 'emails')).toBe(true);
}, 30000);
