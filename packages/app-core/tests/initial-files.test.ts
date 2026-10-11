import { afterEach, expect, it } from 'vitest';
import { MemoryBackend } from '@itookit/vfs-core';
import { FlowCommand } from '@itookit/llm-flow/contracts';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { MindosInitialFiles } from '../src/presets/initial-files';
import demo from '../src/presets/digital-twin-demo.json';

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
    const entries = await library.list();
    expect(entries.map(entry => entry.name)).toEqual(['demo.md', 'essay-review-isolated.flow', 'essay-review.flow']);
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
    expect(await library.restore(['flow:essay-review-isolated', 'flow:essay-review'])).toEqual([
        { id: 'flow:essay-review-isolated', status: 'restored' }, { id: 'flow:essay-review', status: 'preserved' },
    ]);
    expect(await runtime.commandBus.execute(FlowCommand.DraftLoad, { id: 'essay-review-isolated' })).toBeTruthy();
    expect(await notes.driver.exists('/demo.md')).toBe(false);
    expect(await library.restore(['flow:essay-review-isolated'])).toEqual([{ id: 'flow:essay-review-isolated', status: 'preserved' }]);
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
it('allows concurrent explicit note recovery without overwriting the winning write', async () => {
    const { runtime, notes, library } = await setup();
    const other = new MindosInitialFiles(runtime.commandBus, notes);
    const results = (await Promise.all([library.restore(['note:demo']), other.restore(['note:demo'])])).flat();
    expect(results.map(result => result.status).sort()).toEqual(['preserved', 'restored']);
    expect(await notes.driver.readContent('/demo.md', { encoding: 'utf-8' })).toBe(demo.content);
});
