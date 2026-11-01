// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '../src';
import {mountKanban, type KanbanPresentation} from '../src/ui';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); document.body.replaceChildren();});
const presentation = (prefix: string): KanbanPresentation => ({text: key => `${prefix}:${key}`, icons: {refreshView: '', more: '', close: ''}, log: vi.fn()});
async function fixture(prefix = 'one') {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const service = createKanbanModule({store, actor: {kind: 'human', id: 'person'}, authorize: async () => {}, log: vi.fn()});
    const root = document.createElement('section'); document.body.append(root);
    const view = await mountKanban(root, {service, presentation: presentation(prefix), selected: vi.fn(), openSession: vi.fn()});
    closes.push(() => view.destroy());
    return {root, service, view};
}
async function idle(root: HTMLElement) {await vi.waitFor(() => expect(root.querySelector('main')!.hasAttribute('aria-busy')).toBe(false));}
async function click(root: HTMLElement, selector: string) {root.querySelector<HTMLButtonElement>(selector)!.click(); await idle(root);}
function fill(root: HTMLElement, name: string, value: string) {
    const field = root.querySelector<HTMLInputElement>(`[name=${name}]`)!;
    field.value = value; field.dispatchEvent(new Event('input', {bubbles: true}));
}
async function submit(root: HTMLElement, kind: string) {await click(root, `[data-form=${kind}] button:not([type])`);}
it('mounts an independent board, completes and restores work entirely through DOM controls', async () => {
    const {root, service} = await fixture();
    await click(root, '[data-action=new-board]'); fill(root, 'title', '<Independent>'); await submit(root, 'board');
    expect(root.querySelector('main h2')?.textContent).toBe('<Independent>'); expect(root.querySelector('independent')).toBeNull();
    expect(root.querySelector('[name=execution]')).toBeNull();
    await click(root, '[data-action=new-item]'); fill(root, 'title', 'First'); fill(root, 'responsibility', 'Do work'); fill(root, 'acceptance', 'Verify'); await submit(root, 'item');
    const board = (await service.list())[0], id = board.items[0].id;
    await click(root, '[data-action=ready]'); await submit(root, 'claim'); fill(root, 'resultRef', 'record:result'); await submit(root, 'submit');
    expect((await service.item(board.id, id)).item.status).toBe('completed');
    await click(root, '[data-action=archive]'); expect((await service.item(board.id, id)).archive).toBeDefined();
    await click(root, '[data-action=restore]'); expect((await service.item(board.id, id)).archive).toBeUndefined();
});
it('isolates presentation between simultaneous instances and preserves drafts through failed writes', async () => {
    const first = await fixture('first'), second = await fixture('second');
    await click(first.root, '[data-action=new-board]'); fill(first.root, 'title', 'Draft');
    first.view.invalidateFromEvents();
    await expect(first.view.openResource('/')).rejects.toThrow('first:unsaved');
    vi.spyOn(first.service, 'create').mockRejectedValueOnce(Object.assign(new Error('private text'), {code: 'EIO'}));
    await submit(first.root, 'board');
    expect(first.root.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Draft');
    expect(first.root.textContent).toContain('EIO'); expect(first.root.textContent).not.toContain('private text');
    expect(first.root.textContent).not.toContain('second:'); expect(second.root.textContent).not.toContain('first:');
    await submit(first.root, 'board'); expect((await first.service.list())).toHaveLength(1);
});
