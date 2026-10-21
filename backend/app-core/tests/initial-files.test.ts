import { afterEach, expect, it } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { MindosInitialFiles } from '../src/presets/initial-files';
import demo from '../src/presets/digital-twin-demo.json';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import { createMindosFlowLibrary } from '../src/presets/flow-library';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
    const runtime = await createApplicationRuntime({ backend: new MemoryBackend(), digitalTwinAutoStart: false });
    cleanup.push(() => runtime.dispose());
    const notes = await runtime.vfs.openFileSystem('/home/admin/minds');
    return { runtime, notes, library: new MindosInitialFiles(runtime.commandBus, notes) };
}
it('lists exact files, restores only selected notes and preserves edits', async () => {
    const { runtime, notes, library } = await setup();
    await runtime.flowEngine.engine.driver.delete(['/essay-review-isolated.flow']);
    const entries = await library.list();
    expect(entries.map(entry => entry.name)).toEqual(['demo.md', 'essay-review-isolated.flow', 'anki-build.flow', 'anki-generate.flow', 'anki-from-image.flow', 'essay-review.flow']);
    expect(entries[0]).toMatchObject({ path: '/home/admin/minds/demo.md', exists: false });
    expect(await library.restore(['note:demo'])).toEqual([{ id: 'note:demo', status: 'restored' }]);
    expect(await notes.driver.readContent('/demo.md', { encoding: 'utf-8' })).toBe(demo.content);
    expect(await runtime.commandBus.execute(FlowCommand.DraftLoad, { id: 'essay-review-isolated' })).toBeNull();
    await notes.driver.writeContent('/demo.md', 'Personal edit');
    expect(await library.restore(['note:demo'])).toEqual([{ id: 'note:demo', status: 'preserved' }]);
    expect(await notes.driver.readContent('/demo.md', { encoding: 'utf-8' })).toBe('Personal edit');
    await notes.driver.delete(['/demo.md']);
    expect(await library.restore(['note:demo'])).toEqual([{ id: 'note:demo', status: 'restored' }]);
    expect(await notes.driver.readContent('/demo.md', { encoding: 'utf-8' })).toBe(demo.content);
});
it('restores selected Flow templates through real commands and does not create unselected notes', async () => {
    const { runtime, notes, library } = await setup();
    await runtime.flowEngine.engine.driver.delete(['/essay-review-isolated.flow']);
    expect(await library.restore(['flow:essay-review-isolated', 'flow:essay-review'])).toEqual([
        { id: 'flow:essay-review-isolated', status: 'restored' }, { id: 'flow:essay-review', status: 'preserved' },
    ]);
    expect(await runtime.commandBus.execute(FlowCommand.DraftLoad, { id: 'essay-review-isolated' })).toBeTruthy();
    expect(await notes.driver.exists('/demo.md')).toBe(false);
    expect(await library.restore(['flow:essay-review-isolated'])).toEqual([{ id: 'flow:essay-review-isolated', status: 'preserved' }]);
});
it('restores the Anki Flow after deletion and preserves user edits on repeated recovery', async () => {
    const { runtime, notes, library } = await setup();
    const id = 'flow:anki-generate';
    await runtime.flowEngine.engine.driver.delete(['/anki-generate.flow']);
    expect((await library.list()).find(entry => entry.id === id)).toMatchObject({ group: 'flows', exists: false });
    expect(await library.restore([id])).toEqual([{ id, status: 'restored' }]);
    const flow = await runtime.commandBus.execute<Record<string, unknown>>(FlowCommand.DraftLoad, { id: 'anki-generate' });
    await runtime.commandBus.execute(FlowCommand.DraftSave, { draft: { ...flow, name: 'My cards' }, expectedDraftVersion: flow.draftVersion });
    expect(await library.restore([id])).toEqual([{ id, status: 'preserved' }]);
    expect(await runtime.commandBus.execute(FlowCommand.DraftLoad, { id: 'anki-generate' })).toMatchObject({ name: 'My cards' });
    expect(await notes.driver.exists('/demo.md')).toBe(false);
});
it('rejects unknown files before any write and reports per-file failures without hiding successful writes', async () => {
    const { runtime, notes, library } = await setup();
    await expect(library.restore(['note:demo', '../private'])).rejects.toThrow('INITIAL_FILE_UNKNOWN');
    expect(await notes.driver.exists('/demo.md')).toBe(false);
    const failing = new MindosInitialFiles({ execute: async () => { throw new Error('Flow unavailable'); } } as typeof runtime.commandBus, notes);
    expect(await failing.restore(['note:demo', 'flow:essay-review-isolated'])).toEqual([
        { id: 'note:demo', status: 'restored' }, { id: 'flow:essay-review-isolated', status: 'failed', error: 'Flow unavailable' },
    ]);
});

it('restores the shared Flow before its entries and publishes callable dependency revisions', async () => {
    const { runtime, library } = await setup();
    const ids = ['anki-build', 'anki-generate', 'anki-from-image'];
    await runtime.flowEngine.engine.driver.delete(ids.map(id => `/${id}.flow`));
    expect(await library.restore(ids.map(id => `flow:${id}`))).toEqual(ids.map(id => ({ id: `flow:${id}`, status: 'restored' })));
    for (const id of ids.slice(1)) {
        const revision = await runtime.commandBus.execute(FlowCommand.RevisionGet, { id });
        expect(revision).toMatchObject({ dependencyLocks: { build: { flowId: 'anki-build', revision: expect.any(Number) } } });
    }
});
it('allows concurrent explicit note recovery without overwriting the winning write', async () => {
    const { runtime, notes, library } = await setup();
    const other = new MindosInitialFiles(runtime.commandBus, notes);
    const results = (await Promise.all([library.restore(['note:demo']), other.restore(['note:demo'])])).flat();
    expect(results.map(result => result.status).sort()).toEqual(['preserved', 'restored']);
    expect(await notes.driver.readContent('/demo.md', { encoding: 'utf-8' })).toBe(demo.content);
});

it('owns publication in the application recovery command and leaves existing edits unpublished', async () => {
    const { runtime } = await setup();
    const template = createMindosFlowLibrary()[0];
    await runtime.flowEngine.engine.driver.delete([`/${template.id}.flow`]);
    expect(await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [template] })).toBe(1);
    const before = await runtime.commandBus.execute(FlowCommand.RevisionGet, { id: template.id });
    const draft = await runtime.commandBus.execute<any>(FlowCommand.DraftLoad, { id: template.id });
    await runtime.commandBus.execute(FlowCommand.DraftSave, { draft: { ...draft, name: 'Personal changes' }, expectedDraftVersion: draft.draftVersion });
    expect(await runtime.commandBus.execute(FlowLibraryCommand.Restore, { templates: [template] })).toBe(0);
    expect(await runtime.commandBus.execute(FlowCommand.RevisionGet, { id: template.id })).toEqual(before);
    expect(await runtime.commandBus.execute(FlowCommand.DraftLoad, { id: template.id })).toMatchObject({ name: 'Personal changes' });
});
