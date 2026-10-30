// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, FSError} from '@itookit/vfs-core';
import {Workbench} from '../src/core/Workbench';
import {createDirectoryList, refreshDirectoryList, relocateDirectoryList} from '../src/workbench/directory-list';

afterEach(() => {document.body.replaceChildren(); vi.restoreAllMocks();});
it('discards an old in-flight missing-directory error after relocation and reads the new path', async () => {
    let reject!: (error: Error) => void;
    const old = new Promise<never>((_, fail) => {reject = fail;});
    const refresh = vi.fn().mockReturnValueOnce(old).mockResolvedValue([{id:'/new/a.md',name:'a.md',type:'file'}]);
    const panel = document.createElement('div'), list = createDirectoryList({title:'old',path:'/old',entries:[],open(){},refresh});
    panel.append(list); document.body.append(panel);
    const pending = refreshDirectoryList(panel);
    relocateDirectoryList(panel,'/new','new',[{id:'/new',label:'new'}]);
    reject(new FSError('ENOENT','Old path removed'));
    await pending;
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(list.querySelector('[data-resource-id="/new/a.md"]')).not.toBeNull();
    expect(list.querySelector<HTMLElement>('[role=status]')!.hidden).toBe(true);
});
it.each(['move', 'rename'] as const)('relocates open directories, descendant files and route after a parent %s', async operation => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    await fs.driver.createDirectory({parentPath:'/',name:'docs'});
    await fs.driver.createDirectory({parentPath:'/docs',name:'child'});
    await fs.driver.createDirectory({parentPath:'/',name:'target'});
    await fs.driver.createFile({parentPath:'/docs/child',name:'a.md',content:'draft'});
    const sidebar = document.createElement('aside'), main = document.createElement('main'); document.body.append(sidebar, main);
    const updateNodeId = vi.fn(), destroy = vi.fn(), relocated = vi.fn();
    const factory = vi.fn(async () => ({destroy, updateNodeId, setTitle() {}, flushPendingSave:async()=>{}, on:()=>()=>{}}));
    const workbench = new Workbench({files:{fs,cwd:'/'}, sidebarContainer:sidebar, editorContainer:main,
        editorFactory:factory as never, onResourceRelocated:relocated});
    const next = operation === 'move' ? '/target/docs' : '/renamed';
    try {
        await workbench.start(); await workbench.openFile('/docs/child'); await workbench.openFile('/docs/child/a.md');
        main.querySelector('[data-tab-id="/docs/child/a.md"]')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
        await workbench.openFile('/docs/child');
        const directory = main.querySelector('.workbench-tabs__panel:not([hidden]) .workbench-directory')!;
        const search = directory.querySelector<HTMLInputElement>('input[type=search]')!; search.value='a'; search.dispatchEvent(new Event('input'));
        const read = vi.spyOn(fs.driver,'getChildren'); read.mockClear();
        if (operation === 'move') await fs.driver.move(['/docs'],'/target'); else await fs.driver.rename('/docs','renamed');
        await vi.waitFor(()=>expect(workbench.getActiveFilePath()).toBe(next+'/child'));
        await refreshDirectoryList(directory.parentElement!);
        expect(read.mock.calls.every(([path])=>!path.startsWith('/docs'))).toBe(true);
        expect(directory.querySelector('[aria-current=page]')?.textContent).toBe('child');
        expect(directory.querySelector(`[data-directory-path="${next}"]`)).not.toBeNull();
        expect(directory.querySelector(`[data-resource-id="${next}/child/a.md"]`)).not.toBeNull();
        expect(search.value).toBe('a'); expect(main.querySelector('[role=alert]')).toBeNull();
        expect(updateNodeId).toHaveBeenCalledWith(next+'/child/a.md');
        expect(relocated).toHaveBeenCalledWith(next+'/child');
        await workbench.openFile(next+'/child/a.md');
        expect(factory).toHaveBeenCalledOnce(); expect(destroy).not.toHaveBeenCalled();
    } finally {await workbench.destroy(); await manager.dispose();}
});
