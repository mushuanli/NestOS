import { showNameDialog } from '../files/project-dialog';
import { t, FILE_BROWSER_ICONS, FILE_ICONS, type NavigationRequest } from '@itookit/common';
import { directoryBulkActions } from '../workbench/vfs-actions';
import { watchDirectoryList } from '../workbench/directory-watch';
import type { EditorFactory, IEditor, EditorHostContext } from '@itookit/ui-common';
import type { IFileSystem, FileSystemContext } from '@itookit/vfs-core';
import { FSError, guessMimeType } from '@itookit/vfs-core';
import { allowsRowAction, filterGitignoredFiles, type VFSUIShell, type VFSNodeUI } from '@itookit/vfs-ui';
import { EditorLease } from './editor-lease';
import { fileContentFormat } from './file-format';
import { parseFileInfo, extractTaskCounts } from './parser';
import { MediaViewerEditor, isBinaryViewable } from './MediaViewerEditor';
import { LatestViewLoad, type ViewLoad } from '../lifecycle/view-load';
import { WorkbenchTabs, type WorkbenchTab } from '../workbench/tabs';
import { WorkbenchSidebar } from '../workbench/sidebar';
import { createDirectoryList, refreshDirectoryList, watchDirectorySelection } from '../workbench/directory-list';
import type { WorkbenchStatePort } from '../workbench/state';

export interface ConnectOptions<Node extends VFSNodeUI = VFSNodeUI> {
    resolveEditor?: (node: Node) => EditorFactory | null | undefined;
    onEditorCreated?: (editor: IEditor | null) => void;
    saveDebounceMs?: number;
    files?: FileSystemContext;
    sidebarContainer?: HTMLElement;
    emptyMessage?: string;
    workbenchState?: WorkbenchStatePort;
    refreshFileMetadata?: boolean;
    canCreateEntries?: boolean;
    [key: string]: any;
}
interface OpenView { node: VFSNodeUI; editor?: IEditor; lease?: EditorLease; cancel?: () => void }
const replacePrefix = (path: string, old: string, next: string) => path === old || path.startsWith(old + '/') ? next + path.slice(old.length) : path;

/** Each open file owns its editor and save coordinator independently of navigation. */
export function connectEditorLifecycle(vfs: VFSUIShell, engine: IFileSystem, container: HTMLElement,
    factory?: EditorFactory, options: ConnectOptions = {}): (() => Promise<void>) & { setVisible(visible: boolean): Promise<void>; openDirectory(path: string): Promise<void> } {
    const { resolveEditor, onEditorCreated, files = { fs: engine, cwd: '/' }, sidebarContainer, workbenchState, emptyMessage, saveDebounceMs: _debounce, ...extra } = options;
    if (files.fs !== engine) throw new Error('Editor file context differs from its file tree');
    const loads = new LatestViewLoad(), pending = new Set<Promise<void>>();
    let visible = true, closed = false, pendingItem: VFSNodeUI | undefined, sidebar: WorkbenchSidebar | undefined;
    const report = (error: unknown) => {
        const notice = document.createElement('p'); notice.className = 'session-detail__error'; notice.setAttribute('role', 'alert');
        notice.textContent = error instanceof Error ? error.message : String(error); tabs.content.append(notice);
    };
    const tabs = new WorkbenchTabs<OpenView>(container, {
        activate: async id => { if (id === '/') await openDirectory(id); else await vfs.selectPath(id); }, dispose: disposeTab,
        empty: () => { placeholder(); onEditorCreated?.(null); }, error: report,
        changed: () => sidebar?.save(tabs.snapshot()),
    }, workbenchState?.load()?.tabs);
    if (sidebarContainer) sidebar = new WorkbenchSidebar(sidebarContainer, tabs.opened, workbenchState);
    async function flush(editor?: IEditor): Promise<void> {
        if (editor?.flushPendingSave) await editor.flushPendingSave();
        else if (editor?.isDirty?.()) throw new Error('Dirty editor does not support flushing');
    }
    async function disposeTab(tab: WorkbenchTab<OpenView>): Promise<void> {
        const view = tab.value; if (!view) return;
        await flush(view.editor);
        view.lease ??= new EditorLease(view.editor, async () => { view.cancel?.(); });
        await view.lease.dispose();
    }
    function placeholder(): void { tabs.content.textContent = emptyMessage ?? t('workbench.selectFile'); }
    let selectionWork: Promise<void> = Promise.resolve();
    function host(): EditorHostContext {
        const external = extra.hostContext as EditorHostContext | undefined;
        return { openFile: async (path, anchor) => {
                if (!await engine.driver.getNode(path)) throw new FSError('ENOENT', 'File not found', 'open', path);
                await vfs.selectPath(path); await selectionWork; await Promise.all(pending);
                if (anchor && tabs.current?.id === path) await tabs.current.value?.editor?.navigateTo({ elementId: anchor });
            }, chatFromFile: external?.chatFromFile, toggleSidebar: () => vfs.toggleSidebar(),
            navigate: async (request: NavigationRequest) => { await external?.navigate?.(request); }, saveContent: persist };
    }
    async function persist(path: string, content: string): Promise<void> {
        await engine.driver.writeContent(path, content);
        if (options.refreshFileMetadata === false || fileContentFormat(path).contentFormat !== 'markdown') return;
        try { const { metadata, summary } = parseFileInfo(content); await engine.driver.updateMetadata(path, { ...metadata, _summary: summary }); }
        catch (error) { console.error('[EditorConnector] Metadata refresh failed:', error); }
    }
    function bind(tab: WorkbenchTab<OpenView>, view: OpenView): void {
        tabs.bind(tab, view.editor);
        if (!view.editor?.on) return;
        tab.subscriptions.push(view.editor.on('optimisticUpdate', () => {
            const stats = extractTaskCounts(view.editor!.getText());
            vfs.updateNodeMetadata(view.node.id, { custom: { ...view.node.metadata.custom, taskCount: stats } });
        }));
    }
    async function directoryEntries(path: string) {
        const nodes = await filterGitignoredFiles(engine, await engine.driver.getChildren(path));
        return nodes.map(node => ({ id: node.path, name: node.name, type: node.type, icon: vfs.getResourceIcon(node), created: node.createdAt, modified: node.modifiedAt, size: node.type === 'file' ? node.size : undefined }));
    }
    async function createEntry(path: string, type: 'file' | 'directory'): Promise<void> {
        await showNameDialog(t(type === 'file' ? 'project.createFile' : 'project.createFolder'), t('project.newFileName'), lifetime.signal, async name => {
            if (type === 'file') await vfs.sessionService.createFile({ title: name, parentPath: path });
            else await vfs.sessionService.createDirectory({ title: name, parentPath: path });
            await vfs.refresh(); await openDirectory(path);
        });
    }
    const lifetime = new AbortController();
    async function directory(tab: WorkbenchTab<OpenView>, item: VFSNodeUI, load: ViewLoad): Promise<void> {
        tabs.setIcon(tab.id, item.icon ?? FILE_ICONS.folder);
        const nodes = await filterGitignoredFiles(engine, await engine.driver.getChildren(item.id, { signal: load.signal }), load.signal); load.check();
        const readOnly = !allowsRowAction('create-in-folder-session', extra.readOnly === true, item) || (await engine.capabilitiesAt(item.id)).readonly; load.check();
        const parent = item.id.slice(0, item.id.lastIndexOf('/')) || '/';
        tab.panel.replaceChildren(createDirectoryList({ title: item.metadata.title, path: item.id,
            entries: nodes.map(node => ({ id: node.path, name: node.name, type: node.type, icon: vfs.getResourceIcon(node), created: node.createdAt, modified: node.modifiedAt, size: node.type === 'file' ? node.size : undefined })),
            contextMenu: (event, id) => { void vfs.showItemMenu(event, id).catch(report); }, select: ids => vfs.setSelection(ids),
            selectedIds: () => vfs.getSnapshot().selectedIds,
            bulkActions: directoryBulkActions(vfs),
            actions: readOnly ? undefined : [{ label: t('project.createFile'), icon: FILE_BROWSER_ICONS.addFile, disabled: options.canCreateEntries === false, run: () => { void createEntry(item.id, 'file').catch(report); } },
                { label: t('project.createFolder'), icon: FILE_BROWSER_ICONS.addFolder, disabled: options.canCreateEntries === false, run: () => { void createEntry(item.id, 'directory').catch(report); } }],
            open: id => { void vfs.selectPath(id).catch(report); },
            parent: item.id === '/' ? undefined : () => { void (parent === '/' ? openDirectory(parent) : vfs.selectPath(parent)).catch(report); },
            refresh: () => directoryEntries(item.id).catch(error => { report(error); throw error; }) }));
        tab.subscriptions.push(watchDirectoryList(engine, tab.panel, report));
        tab.subscriptions.push(watchDirectorySelection(tab.panel, vfs));
    }
    async function create(tab: WorkbenchTab<OpenView>, item: VFSNodeUI, load: ViewLoad): Promise<void> {
        if (item.icon) tabs.setIcon(tab.id, item.icon);
        const view: OpenView = { node: item };
        if (item.type === 'directory') await directory(tab, item, load);
        else {
            const raw = item.content?.data !== undefined ? item.content.data : await engine.driver.readContent(item.id);
            load.check(); const mime = guessMimeType('file' + (item.metadata.custom?._extension ?? ''));
            const mount = document.createElement('div'); mount.className = 'session-editor-mount'; tab.panel.replaceChildren(mount);
            if (isBinaryViewable(mime)) { const editor = new MediaViewerEditor(mime); await editor.init(mount, raw); view.editor = editor; }
            else {
                const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
                const createEditor = resolveEditor?.(item) ?? factory;
                if (!createEditor) throw new Error('No suitable editor factory found.');
                view.editor = await createEditor(mount, { ...extra, ...fileContentFormat(item.id), files, signal: load.signal,
                    target: { kind: 'file', path: item.id }, initialContent: text, title: item.metadata.title,
                    language: item.metadata.custom?._extension, hostContext: host() });
            }
            if (!loads.isCurrent(load) || closed) { await view.editor?.destroy(); return; }
        }
        load.check(); view.cancel = loads.detach(load); tab.value = view; bind(tab, view);
        onEditorCreated?.(view.editor ?? null);
    }
    async function select({ item }: { item?: VFSNodeUI }, reload = false): Promise<void> {
        pendingItem = item; if (!visible || closed) return;
        const load = loads.begin();
        try { await flush(tabs.current?.value?.editor); } catch (error) { report(error); return; }
        if (!loads.isCurrent(load)) return;
        if (!item) { if (!tabs.current?.value) placeholder(); return; }
        if (item.type === 'file' && tabs.current?.value?.node.type === 'directory') tabs.keep(tabs.current.id);
        const existing = tabs.get(item.id);
        if (existing?.value && !reload) { tabs.activate(item.id); await refreshDirectoryList(existing.panel); onEditorCreated?.(existing.value.editor ?? null); return; }
        if (existing && reload) await tabs.close(existing.id, false);
        const tab = await tabs.open(item.id, item.metadata.title || item.id);
        if (!loads.isCurrent(load)) return;
        const task = new Promise<void>(resolve => setTimeout(resolve, 0)).then(() => create(tab, item, load)).catch(error => {
            if (loads.isCurrent(load)) { tab.panel.replaceChildren(); report(error); }
        });
        pending.add(task); void task.finally(() => pending.delete(task));
    }
    const unsubscribe = [vfs.on('sessionSelected', event => { selectionWork = select(event).catch(report); }),
        vfs.on('navigateToHeading', ({ elementId }) => tabs.current?.value?.editor?.navigateTo({ elementId })),
        vfs.on('fileRenamed', ({ oldId, newId, item }) => {
            for (const tab of tabs.values()) {
                const next = replacePrefix(tab.id, oldId, newId); if (next === tab.id) continue;
                const view = tab.value; if (view) { view.node = vfs.getNode(next) ?? { ...view.node, id: next }; view.editor?.updateNodeId?.(next); }
                const title = next === newId ? item.metadata.title : tab.title; view?.editor?.setTitle?.(title); tabs.rename(tab.id, next, title);
                if (next === newId && item.icon) tabs.setIcon(next, item.icon);
            }
        })];
    if (typeof engine.on === 'function') unsubscribe.push(engine.on('node:moved', event => {
        for (const { oldPath, newPath } of event.payload.nodes) for (const tab of tabs.values()) {
            const next = replacePrefix(tab.id, oldPath, newPath); if (next === tab.id) continue;
            const title = next.split('/').pop() || tab.title;
            if (tab.value) { tab.value.node = { ...tab.value.node, id: next }; tab.value.editor?.updateNodeId?.(next); tab.value.editor?.setTitle?.(title); }
            tabs.rename(tab.id, next, title);
        }
    }), engine.on('node:deleted', event => {
        for (const tab of tabs.values()) if (event.payload.requestedPaths.some(path => tab.id === path || tab.id.startsWith(path + '/')))
            void tabs.close(tab.id, false).catch(report);
    }));
    placeholder();
    const dispose = async () => {
        closed = true; lifetime.abort(); loads.cancel(); unsubscribe.forEach(fn => fn()); await Promise.allSettled(pending);
        sidebar?.save(tabs.snapshot()); await tabs.destroy(); sidebar?.destroy();
    };
    async function openDirectory(path: string): Promise<void> {
        const node = await engine.driver.getNode(path);
        if (path !== '/' && (!node || node.type !== 'directory')) return;
        await select({ item: { id: path, type: 'directory', icon: node ? vfs.getResourceIcon(node) : FILE_ICONS.folder, version: '1', metadata: { title: node?.name || t('project.files'), path,
            parentPath: node?.parentPath ?? null, tags: [], createdAt: new Date(node?.createdAt ?? 0).toISOString(), lastModified: new Date(node?.modifiedAt ?? 0).toISOString(), custom: node?.metadata ?? {} } } });
    }
    return Object.assign(dispose, { openDirectory, async setVisible(next: boolean): Promise<void> {
        if (visible === next) return; visible = next;
        if (!next) { loads.cancel(); await Promise.all(tabs.values().map(tab => flush(tab.value?.editor))); }
        else if (pendingItem && (tabs.current?.id !== pendingItem.id || !tabs.current?.value)) await select({ item: pendingItem });
    } });
}
