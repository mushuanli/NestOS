// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createKanbanModule, SeqKanbanStore} from '../src';
import {mountKanban, type KanbanPresentation} from '../src/ui';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); document.body.replaceChildren();});
const presentation = (prefix: string): KanbanPresentation => ({text: key => `${prefix}:${key}`, icons: {refreshView: '', more: '', close: ''}, log: vi.fn()});
async function fixture(prefix = 'one', mountNavigation?: (container: HTMLElement) => () => void) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const service = createKanbanModule({store, actor: {kind: 'human', id: 'person'}, authorize: async () => {}, log: vi.fn()});
    const root = document.createElement('section'); document.body.append(root);
    const view = await mountKanban(root, {service, presentation: presentation(prefix), selected: vi.fn(), openSession: vi.fn(), mountNavigation});
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
    const header = root.querySelector('[data-panel] .kanban__panel-header')!;
    expect(header.querySelector('.ui-content-titlebar')?.firstElementChild?.getAttribute('data-action')).toBe('close-panel');
    expect(header.querySelector('h3')?.getAttribute('title')).toBe('First');
    expect(header.querySelector('[data-action=copy-link]')?.getAttribute('data-copy')).toBe(`/board/${board.id}/${id}`);
    expect(root.querySelector('[data-panel] .kanban__reference')).toBeNull();
    await click(root, '[data-panel] .kanban__panel-back');
    expect(root.querySelector<HTMLElement>('[data-panel]')!.hidden).toBe(true);
    await click(root, `[data-item="${id}"]`);
    await click(root, '[data-action=ready]'); await submit(root, 'claim'); fill(root, 'resultRef', 'record:result'); await submit(root, 'submit');
    expect((await service.item(board.id, id)).item.status).toBe('completed');
    await click(root, '[data-action=archive]'); expect((await service.item(board.id, id)).archive).toBeDefined();
    await click(root, '[data-action=restore]'); expect((await service.item(board.id, id)).archive).toBeUndefined();
});
it('keeps reference and secondary actions in the menu and preserves filters and host navigation across refreshes', async () => {
    const release = vi.fn(), mount = vi.fn((container: HTMLElement) => {
        const button = document.createElement('button'); button.dataset.hostNavigation = ''; container.append(button); return release;
    });
    const {root, view} = await fixture('one', mount);
    await click(root, '[data-action=new-board]'); fill(root, 'title', 'Mobile board'); await submit(root, 'board');
    const header = root.querySelector('main .kanban__page-header')!;
    expect(header.querySelector('.kanban__board-heading code')).toBeNull();
    expect(header.querySelector('.kanban__menu-reference')).not.toBeNull();
    expect(header.querySelector('.kanban__menu [data-action=refresh]')).not.toBeNull();
    expect(root.querySelector('[data-host-navigation]')).not.toBeNull();
    const filter = root.querySelector<HTMLSelectElement>('[name=view]')!; filter.value = 'archive';
    expect(filter.closest('details')).not.toBeNull(); await submit(root, 'filter');
    expect(root.querySelector<HTMLSelectElement>('[name=view]')!.value).toBe('archive');
    expect(mount).toHaveBeenCalledTimes(3); expect(release).toHaveBeenCalledTimes(2);
    await view.destroy(); expect(release).toHaveBeenCalledTimes(3);
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
it('configures published AI targets through the board menu and defaults to independent acceptance', async () => {
    const {root, service} = await fixture();
    const catalog = {targets: [{label: 'Planner', reference: {system: 'published', id: 'planner', revision: '1'}},
        {label: 'Executor', reference: {system: 'published', id: 'executor', revision: '1'}}],
        coordinator: {kind: 'service' as const, id: 'planner'}, worker: {kind: 'service' as const, id: 'worker'}};
    Object.assign(service, {automationCatalog: async () => catalog});
    await click(root, '[data-action=new-board]'); fill(root, 'title', 'AI work'); await submit(root, 'board');
    expect(root.querySelector('.kanban__menu [data-action=automation]')).not.toBeNull();
    await click(root, '[data-action=automation]');
    expect(root.querySelector<HTMLInputElement>('[name=autoAccept]')!.checked).toBe(false);
    fill(root, 'planner', JSON.stringify(catalog.targets[0].reference)); fill(root, 'executor', JSON.stringify(catalog.targets[1].reference));
    root.querySelector<HTMLInputElement>('[name=enabled]')!.checked = true;
    await submit(root, 'automation');
    const board = (await service.list())[0];
    expect(board.automation).toMatchObject({enabled: true, autoAccept: false, planner: catalog.targets[0].reference});
    expect(board.policy.review).toBe('independent');
    expect(board.members?.find(member => member.id === 'worker')?.roles).toContain('worker');
    expect(root.querySelector<HTMLElement>('[data-panel]')!.hidden).toBe(true);
});
it('shows host preparation choices when selected and persists explicit commit policy', async () => {
    const {root, service} = await fixture();
    const reference = {system: 'host-preparation', id: 'isolated', revision: '1'};
    const catalog = {targets: [{label: 'Agent', reference: {system: 'published', id: 'agent', revision: '1'}}],
        preparations: [{label: 'Workspace', reference, options: [{name: 'commit', label: 'Commit policy', defaultValue: 'changes', choices: [
            {value: 'changes', label: 'Keep changes'}, {value: 'worktree', label: 'Commit in task branch'}]}]}],
        coordinator: {kind: 'service' as const, id: 'planner'}, worker: {kind: 'service' as const, id: 'worker'}};
    Object.assign(service, {automationCatalog: async () => catalog});
    await click(root, '[data-action=new-board]'); fill(root, 'title', 'Policy'); await submit(root, 'board');
    await click(root, '[data-action=automation]');
    const preparation = root.querySelector<HTMLSelectElement>('[name=preparation]')!;
    preparation.value = JSON.stringify(reference); preparation.dispatchEvent(new Event('change', {bubbles: true}));
    expect(root.querySelector<HTMLSelectElement>('[name=preparation-option-commit]')?.value).toBe('changes');
    fill(root, 'preparation-option-commit', 'worktree');
    fill(root, 'planner', JSON.stringify(catalog.targets[0].reference)); fill(root, 'executor', JSON.stringify(catalog.targets[0].reference));
    await submit(root, 'automation');
    expect((await service.list())[0].automation).toMatchObject({preparation: reference, preparationOptions: {commit: 'worktree'}});
    const board = (await service.list())[0];
    await service.execute(board.id, {operationId: 'reorder-reference', expectedRevision: board.revision, command: {
        type: 'configure-automation', settings: {...board.automation!, preparation: {id: reference.id, revision: reference.revision, system: reference.system}}}});
    await viewRefresh();
    async function viewRefresh() {
        await click(root, '[data-action=refresh]'); await click(root, '[data-action=automation]');
        expect(root.querySelector<HTMLSelectElement>('[name=preparation-option-commit]')?.value).toBe('worktree');
    }

});

it('lists children on a feature, prefills its parent when creating work, and opens the parent from a task', async () => {
    const f = await fixture();
    const board = await f.service.create({id: 'hierarchy', title: 'Project', scope: {kind: 'system'}, members: [{kind: 'human', id: 'person', responsibility: 'Manage'}]});
    await f.service.execute(board.id, {operationId: 'feature', expectedRevision: board.revision, command: {type: 'create-item',
        item: {id: 'feature', title: 'Cloze modes', responsibility: 'Support modes', acceptance: 'Verified'}, planning: {kind: 'feature', priority: 2, dependencies: [], references: []}}});
    await f.view.openResource('/board/hierarchy/feature');
    expect(f.root.querySelector('[data-children]')?.textContent).toContain('one:children (0)');
    await click(f.root, '[data-action=new-child]');
    expect(new FormData(f.root.querySelector('[data-form=item]')!).get('parentId')).toBe('feature');
    expect(new FormData(f.root.querySelector('[data-form=item]')!).get('kind')).toBe('task');
    fill(f.root, 'title', 'Implement'); fill(f.root, 'responsibility', 'Code'); fill(f.root, 'acceptance', 'Tests'); await submit(f.root, 'item');
    const child = (await f.service.read(board.id)).items.find(item => item.title === 'Implement')!;
    expect(child.planning?.parentId).toBe('feature');
    await click(f.root, '[data-panel] [data-item=feature]');
    expect(f.root.querySelector('[data-children]')?.textContent).toContain('Implement');
    await click(f.root, '[data-children] [data-item]'); expect(f.view.getActiveResourceId()).toBe('/board/hierarchy/' + child.id);
});
it('runs a decision on its current board by default and requires an explicit action for a new board', async () => {
    const f = await fixture();
    const board = await f.service.create({id: 'development', title: 'Development', scope: {kind: 'system'}, members: [{kind: 'human', id: 'person', responsibility: 'Manage', roles: ['worker', 'reviewer', 'coordinator']}]});
    let state = await f.service.execute(board.id, {operationId: 'decision', expectedRevision: board.revision, command: {type: 'append-record',
        record: {id: 'cloze', kind: 'decision', title: 'Cloze', content: 'Add modes', rationale: 'Tested', itemIds: [], sources: []}}});
    await f.service.execute(board.id, {operationId: 'approve', expectedRevision: state.revision, command: {type: 'review-record', recordId: 'cloze', accept: true}});
    const runRecord = vi.fn(async () => ({id: 'run', recordId: 'cloze', recordRevision: 2, boardId: board.id, state: 'running', createdAt: 1, updatedAt: 1}));
    Object.assign(f.service, {recordExecutions: async () => [], runRecord});
    await f.view.openResource('/board/development/@record/cloze');
    await click(f.root, '[data-action=run-record]');
    expect(runRecord).toHaveBeenLastCalledWith(board.id, expect.objectContaining({placement: 'current-board'}));
    const separate = f.root.querySelector<HTMLButtonElement>('[data-action=run-record-separate]')!;
    separate.closest('details')!.open = true; await click(f.root, '[data-action=run-record-separate]');
    expect(runRecord).toHaveBeenLastCalledWith(board.id, expect.objectContaining({placement: 'new-board'}));
});
