// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {createNestOSKanban} from '@itookit/app-core/kanban';
import {SeqKanbanStore} from '@itookit/kanban/storage';
import {KanbanWorkbench} from '@itookit/kanban/ui';
import {executionSessionReference} from '@itookit/app-contracts';
import {kanbanPresentation} from '../src/kanban/host';
import {t} from '@itookit/common';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {for (const cleanup of cleanups.splice(0)) await cleanup(); document.body.replaceChildren();});
async function fixture(source?: import('@itookit/app-core/kanban').KanbanSessionSource) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const service = createNestOSKanban({store, actor: {kind: 'human', id: 'admin'}, authorize: async () => {}, log: vi.fn(),executionSessions:source?{source}:undefined});
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const selected = vi.fn(), openSession = vi.fn(async () => {}), workbench = new KanbanWorkbench({presentation: kanbanPresentation, executionReference: executionSessionReference, service, sidebar, editor, selected, openSession});
    cleanups.push(async () => {await workbench.destroy(); await manager.dispose();}); await workbench.start();
    return {service, sidebar, editor, workbench, selected, openSession};
}
async function idle(editor: HTMLElement) {await vi.waitFor(() => expect(editor.hasAttribute('aria-busy')).toBe(false));}
async function click(root: HTMLElement, selector: string) {
    const target = root.querySelector<HTMLButtonElement>(selector); expect(target, selector).not.toBeNull(); target!.click();
    await vi.waitFor(() => expect(document.querySelector('main')!.hasAttribute('aria-busy')).toBe(false));
}
function input(root: HTMLElement, name: string, value: string) {
    const field = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!; field.value = value; field.dispatchEvent(new Event('input', {bubbles: true}));
}
async function submit(root: HTMLElement, kind: string) {
    const form = root.querySelector<HTMLFormElement>(`[data-form="${kind}"]`)!;
    form.querySelector<HTMLButtonElement>('button[type=submit], button:not([type])')!.click(); await idle(document.querySelector('main')! as HTMLElement);
}
it('creates durable boards and cards, claims, completes, archives and restores using the visible controls', async () => {
    const f = await fixture(); expect(f.editor.textContent).toContain(t('kanban.emptyBoards'));
    await click(f.editor, '[data-action=new-board]'); input(f.editor, 'title', '<Board>'); await submit(f.editor, 'board');
    expect(f.editor.querySelector('h2')?.textContent).toBe('<Board>'); expect(f.editor.querySelector('board')).toBeNull();
    await click(f.editor, '[data-action=new-item]'); input(f.editor, 'title', 'First card'); input(f.editor, 'responsibility', 'Do the work'); input(f.editor, 'acceptance', 'Result verified');
    await submit(f.editor, 'item'); expect(f.editor.querySelector('[data-form=item]')).toBeNull();
    const board = (await f.service.list())[0], id = board.items[0].id;
    expect(board.items[0].status).toBe('backlog'); await click(f.editor, '[data-action=ready]'); await submit(f.editor, 'claim');
    input(f.editor, 'resultRef', 'record://verified'); await submit(f.editor, 'submit');
    expect((await f.service.item(board.id, id)).item.status).toBe('completed');
    await click(f.editor, '[data-action=archive]'); expect((await f.service.item(board.id, id)).archive).toBeDefined();
    await click(f.editor, '[data-action=restore]'); expect((await f.service.item(board.id, id)).archive).toBeUndefined();
});
it('preserves unsaved input on notifications, failed writes and rejected navigation', async () => {
    const f = await fixture(); await click(f.editor, '[data-action=new-board]'); input(f.editor, 'title', 'Pending form');
    f.workbench.invalidateFromEvents(); expect(f.editor.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Pending form');
    await expect(f.workbench.openResource('/')).rejects.toThrow(t('kanban.unsaved'));
    const create = vi.spyOn(f.service, 'create').mockRejectedValueOnce(Object.assign(new Error('PRIVATE ERROR'), {code: 'EIO'}));
    await submit(f.editor, 'board'); expect(f.editor.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Pending form');
    expect(f.editor.querySelector('[role=alert]')!.textContent).toContain('EIO'); expect(f.editor.textContent).not.toContain('PRIVATE ERROR');
    await submit(f.editor, 'board'); expect(create).toHaveBeenCalledTimes(2); expect((await f.service.list())).toHaveLength(1);
});
it('links a Session and routes the existing identity without opening a second conversation', async () => {
    const f = await fixture(); const board = await f.service.create({id: 'b', title: 'Board', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Work'}], policy: {requireEstimate: false}});
    await f.service.execute('b', {operationId: 'new', expectedRevision: board.revision, command: {type: 'create-item', item: {id: 'card', title: 'Card', responsibility: 'Work', acceptance: 'Done'}}});
    await f.workbench.openResource('/board/b/card');
    const sessionSearch = f.editor.querySelector<HTMLInputElement>('[data-form=session] [role=combobox]')!;
    sessionSearch.value = 'existing-session'; sessionSearch.dispatchEvent(new Event('input', {bubbles: true})); sessionSearch.focus();
    await vi.waitFor(() => expect(f.editor.querySelector('[data-form=session] [role=option]')).not.toBeNull());
    f.editor.querySelector<HTMLButtonElement>('[data-form=session] [role=option]')!.click(); await submit(f.editor, 'session');
    await click(f.editor, '[data-session="existing-session"]'); expect(f.openSession).toHaveBeenCalledWith('existing-session');
});
it('shows an actionable unavailable state when the host has not been updated', async () => {
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const workbench = new KanbanWorkbench({presentation: kanbanPresentation, executionReference: executionSessionReference, sidebar, editor, selected: vi.fn(), openSession: vi.fn()}); await workbench.start();
    expect(editor.textContent).toContain(t('kanban.unavailable')); await workbench.destroy();
});
it('binds an execution Session through the inspector, shows session-only activity and filters the board',async()=>{
    let state='running' as const;
    const inspect=vi.fn(async(_board:unknown,id:string)=>({sessionId:id,title:'Execution conversation',state,lastActivityAt:Date.now()-120000,observedAt:Date.now(),stale:false}));
    const f=await fixture({inspect});await click(f.editor,'[data-action=new-board]');input(f.editor,'title','Sessions');await submit(f.editor,'board');
    await click(f.editor,'[data-action=new-item]');input(f.editor,'title','Work');input(f.editor,'responsibility','Build');input(f.editor,'acceptance','Reviewed');await submit(f.editor,'item');
    expect(f.editor.textContent).toContain(t('kanban.noExecutionSession'));
    const search=f.editor.querySelector<HTMLInputElement>('[data-form=execution-session] [role=combobox]')!;
    search.closest<HTMLDetailsElement>('details')!.open=true;search.value='execution-session';search.dispatchEvent(new Event('input',{bubbles:true}));search.focus();
    await vi.waitFor(()=>expect(f.editor.querySelector('[data-form=execution-session] [role=option]')).not.toBeNull());
    f.editor.querySelector<HTMLButtonElement>('[data-form=execution-session] [role=option]')!.click();await submit(f.editor,'execution-session');
    expect(f.editor.querySelector('[data-execution-session]')!.textContent).toContain('Execution conversation');
    await click(f.editor,'[data-execution-session] [data-session]');expect(f.openSession).toHaveBeenCalledWith('execution-session');
    await click(f.editor,'[data-action=close-panel]');expect(f.editor.querySelector('[data-execution-state=running]')).not.toBeNull();
    const filter=f.editor.querySelector<HTMLSelectElement>('[name=execution]')!;filter.value='recent';await submit(f.editor,'filter');
    expect(f.editor.querySelectorAll('[data-item]')).toHaveLength(1);
    expect(f.editor.querySelector('[data-content]')!.textContent).not.toContain('taskId');expect(inspect).toHaveBeenCalled();
});
it('retries a card write with the same operation and item identities after a lost response', async () => {
    const f = await fixture();
    await click(f.editor, '[data-action=new-board]'); input(f.editor, 'title', 'Board'); await submit(f.editor, 'board');
    await click(f.editor, '[data-action=new-item]'); input(f.editor, 'title', 'Once'); input(f.editor, 'responsibility', 'Work'); input(f.editor, 'acceptance', 'Verified');
    const execute = f.service.execute.bind(f.service);
    const spy = vi.spyOn(f.service, 'execute').mockImplementationOnce(async (...args) => {
        await execute(...args); throw Object.assign(new Error('Lost response'), {outcome: 'unknown'});
    }).mockImplementation(execute);
    await submit(f.editor, 'item'); expect(f.editor.querySelector('[data-form=item]')).not.toBeNull();
    await submit(f.editor, 'item'); expect((await f.service.list())[0].items).toHaveLength(1);
    expect(spy.mock.calls[0][1]).toEqual(spy.mock.calls[1][1]);
});
it('creates linked logs and decisions in the same workspace and confirms a draft without changing work status', async () => {
    const f = await fixture(); await click(f.editor, '[data-action=new-board]'); input(f.editor, 'title', 'Context board'); await submit(f.editor, 'board');
    await click(f.editor, '[data-action=new-item]'); input(f.editor, 'title', 'Work'); input(f.editor, 'responsibility', 'Scope'); input(f.editor, 'acceptance', 'Evidence'); await submit(f.editor, 'item');
    const board = (await f.service.list())[0], id = board.items[0].id;
    await click(f.editor, '[data-action=new-log]'); input(f.editor, 'title', 'Investigation'); input(f.editor, 'content', 'Checked the current implementation.'); await submit(f.editor, 'record');
    let records = await f.service.records(board.id, {itemId: id}); expect(records.items).toHaveLength(1); expect(records.items[0].status).toBe('confirmed');
    await click(f.editor, '[data-item]'); await click(f.editor, '[data-action=new-decision]');
    input(f.editor, 'title', 'Choose a bounded scope'); input(f.editor, 'content', 'Ship the smallest verified change.'); input(f.editor, 'rationale', 'Reduce uncertainty.'); await submit(f.editor, 'record');
    expect(f.editor.textContent).toContain('Reduce uncertainty.'); await click(f.editor, '[data-action=confirm-record]');
    records = await f.service.records(board.id, {kind: 'decision'}); expect(records.items[0].status).toBe('confirmed');
    expect((await f.service.item(board.id, id)).item.status).toBe('backlog');
    await click(f.editor, '[data-item]'); expect(f.editor.querySelector('[data-related-records]')!.textContent).toContain('Investigation');
    expect(f.editor.querySelector('[data-related-records]')!.textContent).toContain('Choose a bounded scope');
    await click(f.editor, '[data-action=close-panel]'); await click(f.editor, '[data-context=decision]');
    expect(f.editor.querySelector('.kanban__record-list')!.textContent).toContain('Choose a bounded scope');
});
it('uses a modal inspector, preserves column scroll and prevents Escape from discarding a draft', async () => {
    const f = await fixture(); await click(f.editor, '[data-action=new-board]'); input(f.editor, 'title', 'Board'); await submit(f.editor, 'board');
    await click(f.editor, '[data-action=new-item]'); input(f.editor, 'title', 'Card'); input(f.editor, 'responsibility', 'Long context'); input(f.editor, 'acceptance', 'Verified'); await submit(f.editor, 'item');
    const panel = f.editor.querySelector<HTMLElement>('[data-panel]')!;
    expect(panel.getAttribute('role')).toBe('dialog'); expect(panel.hidden).toBe(false); expect(f.sidebar.inert).toBe(true);
    expect(f.editor.querySelector<HTMLElement>('[data-content]')!.inert).toBe(true);
    const column = f.editor.querySelector<HTMLElement>('[data-column=backlog]')!; column.scrollTop = 180;
    await click(f.editor, '[data-action=close-panel]'); expect(panel.hidden).toBe(true); expect(column.scrollTop).toBe(180);
    await click(f.editor, '[data-item]'); await click(f.editor, '[data-action=new-log]'); input(f.editor, 'title', 'Unsaved context');
    f.editor.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true})); await idle(f.editor);
    expect(panel.hidden).toBe(false); expect(f.editor.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Unsaved context');
    expect(panel.querySelector('[role=alert]')!.textContent).toContain(t('kanban.unsaved'));
    await click(f.editor, '[data-action=close-panel]'); expect(f.sidebar.inert).toBe(false);
});

it('loads board navigation through the metadata catalog without requesting coordination bodies', async () => {
    const f = await fixture();
    await f.service.create({id:'catalog',title:'Metadata board',scope:{kind:'system'},members:[{kind:'human',id:'admin',responsibility:'Manage',roles:['worker','coordinator']}]});
    const full = vi.spyOn(f.service,'list').mockRejectedValue(new Error('Full body read must not run'));
    f.workbench.invalidateFromEvents();
    await vi.waitFor(()=>expect(f.editor.querySelector('h2')?.textContent).toBe('Metadata board'));
    expect(full).not.toHaveBeenCalled();
});

it('shows stable references, copies references and links, and opens work by its number', async () => {
    const f=await fixture();
    const board=await f.service.create({id:'numbered',title:'Referenced board',scope:{kind:'system'},members:[{kind:'human',id:'admin',responsibility:'Manage',roles:['worker','coordinator']}]});
    await f.service.execute(board.id,{operationId:'numbered-item',expectedRevision:board.revision,command:{type:'create-item',item:{id:'work',title:'Referenced work',responsibility:'Do',acceptance:'Verify'}}});
    f.workbench.invalidateFromEvents();
    await vi.waitFor(()=>expect(f.editor.textContent).toContain('KB-1#1'));
    const writeText=vi.fn(async()=>{});Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});
    const form=f.sidebar.querySelector<HTMLFormElement>('[data-form=reference]')!;
    form.querySelector<HTMLInputElement>('input')!.value='KB-1#1';form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    await vi.waitFor(()=>expect(f.editor.querySelector('[data-panel] h3')?.textContent).toBe('Referenced work'));
    await click(f.editor,'[data-panel] .kanban__menu > summary');
    await click(f.editor,'[data-panel] [data-action=copy-reference]');expect(writeText).toHaveBeenLastCalledWith('KB-1#1');
    await click(f.editor,'[data-panel] [data-action=copy-link]');expect(writeText).toHaveBeenLastCalledWith(expect.stringContaining('#/kanban/%2Fboard%2Fnumbered%2Fwork'));
    writeText.mockRejectedValueOnce(new Error('Denied'));
    await click(f.editor,'[data-panel] [data-action=copy-reference]');expect(f.editor.querySelector('[data-panel-error]')?.textContent).toContain('COPY_FAILED');
    expect(f.workbench.getActiveResourceId()).toBe('/board/numbered/work');
});

it('keeps one board header across tabs and dismisses reference menus before the inspector', async () => {
    const f=await fixture();
    const board=await f.service.create({id:'layout',title:'Consistent header',scope:{kind:'system'},members:[{kind:'human',id:'admin',responsibility:'Manage',roles:['worker','coordinator']}]});
    await f.service.execute(board.id,{operationId:'layout-item',expectedRevision:board.revision,command:{type:'create-item',item:{id:'work',title:'Work',responsibility:'Do',acceptance:'Verify'}}});
    f.workbench.invalidateFromEvents();await vi.waitFor(()=>expect(f.editor.querySelector('.kanban__page-header h2')?.textContent).toBe('Consistent header'));
    expect(f.editor.querySelectorAll('.kanban__page-header')).toHaveLength(1);
    expect(f.sidebar.querySelector<HTMLDetailsElement>('.kanban__reference-lookup')!.open).toBe(false);
    await click(f.editor,'[data-context=log]');expect(f.editor.querySelector('.kanban__page-header h2')?.textContent).toBe('Consistent header');
    expect(f.editor.querySelector('.kanban__page-header [data-action=new-log]')).not.toBeNull();
    expect(f.editor.querySelector('.kanban__page-header [data-action=new-item]')).toBeNull();
    await click(f.editor,'[data-context=board]');await click(f.editor,'[data-item=work]');
    const panel=f.editor.querySelector<HTMLElement>('[data-panel]')!, menu=panel.querySelector<HTMLDetailsElement>('.kanban__menu')!;
    menu.open=true;const summary=menu.querySelector<HTMLElement>('summary')!;
    summary.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
    expect(menu.open).toBe(false);expect(panel.hidden).toBe(false);expect(document.activeElement).toBe(summary);
    menu.open=true;document.body.dispatchEvent(new Event('pointerdown',{bubbles:true}));expect(menu.open).toBe(false);
});
