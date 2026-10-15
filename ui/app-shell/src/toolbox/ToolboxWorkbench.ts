import { presentationPersistence } from '../persistence/initial-navigation';
import { createMindOSVFSUI as createVFSUI } from '../browser/vfs-presentation';
import { ToolboxDeletion, toolboxSelectionPaths } from './ToolboxDeletion';
import { defaultToolDrawers } from './tool-drawers';
import { ConfigurationDeletionDialog } from '../configuration/delete-dialog';
import type { ModelConfigurationCommands } from '@itookit/app-contracts/services';
import { connectEditorLifecycle } from '../browser/editor-connector';
import { DrawerActions } from './DrawerActions';
import { drawerField } from './drawer-field';
import { drawerKind, ungroupedId, type Drawer } from '@itookit/app-contracts';
import { resourceDrawers } from './resource-drawers';
import { resourceIcon } from './resource-icons';
import { mcpStatusIcon } from './mcp-status';
import { modelDrawers, compareModelItems, modelDrawerId, modelDrawerProvider } from './model-drawers';
import { type VFSUIShell, type VFSNodeUI, type VFSToolbarContext, type UIPersistencePort } from '@itookit/vfs-ui';
import { createFileSystemView, type FileSystemView } from '@itookit/vfs-core';
import { ENTITY_ICONS, t, type NavigationRequest } from '@itookit/common';
import { editorResourceId, type EditorFactory, type MenuItem, type ContextMenuConfig } from '@itookit/ui-common';
import type { WorkspaceController } from '@itookit/app-contracts';
import { showNameDialog } from '../files/project-dialog';
import { chooseArchive, downloadArchive } from '../files/archive-transfer';
import type { ToolboxResources } from '@itookit/app-contracts/services';
import { TOOLBOX_KINDS, TOOLBOX_FILTERS, toolboxFilter, toolboxKind, toolboxSourcePath, type ToolboxKind, type ToolboxFilter } from './routes';
import type { ToolboxInventory } from '@itookit/app-contracts/services';

interface Options {
    ocr?: import('../configuration/ocr-controls').OcrConfigurationControls;
    sidebar: HTMLElement; editor: HTMLElement; resources: ToolboxResources; inventory: ToolboxInventory;
    configuration: ModelConfigurationCommands;
    projects?: Pick<import('@itookit/app-contracts/services').ProjectService,'list'>;
    factories: Record<ToolboxKind, EditorFactory>; flowMenu: ContextMenuConfig<VFSNodeUI>;
    navigate(request: NavigationRequest): Promise<void>; selected(path: string | null): void;
    /** Host-owned snapshot storage; omitted means the toolbox restores nothing. */
    uiPersistence?: UIPersistencePort;
    /** Host-owned preference storage; omitted means the toolbox starts from defaults. */
    uiPreferences?: ToolboxPreferencesPort;
}
export interface ToolboxPreferences { filter: ToolboxFilter; queries: Partial<Record<ToolboxFilter, string>> }
/**
 * The toolbox's own filter/query memory. `load` is synchronous because the workbench
 * reads it at construction, so the host prefetches the document first.
 */
export interface ToolboxPreferencesPort { load(): unknown; save(preferences: ToolboxPreferences): void }
/** Document name under `etc:/ui` for {@link ToolboxPreferences}. */
export const TOOLBOX_PREFERENCES_DOC = 'mindos_toolbox_v1.preferences';
/** Browser snapshot scope; kept separate from the preference document. */
export const TOOLBOX_SCOPE = 'mindos:toolbox:v1';

/** Tolerate a missing or hand-edited document: unknown fields fall back to defaults. */
function preferences(data: unknown): ToolboxPreferences {
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const filter = record.filter;
    return { filter: (TOOLBOX_FILTERS as readonly string[]).includes(filter as string) ? filter as ToolboxFilter : 'all',
        queries: Object.fromEntries(Object.entries(record.queries && typeof record.queries === 'object' ? record.queries as Record<string, unknown> : {})
            .filter(([kind, query]) => (TOOLBOX_FILTERS as readonly string[]).includes(kind) && typeof query === 'string')) };
}

/** One resource list; each editor receives its original, authorized source context. */
export class ToolboxWorkbench implements WorkspaceController {
    private deletion!: ConfigurationDeletionDialog;
    private selectionDeletion!: ToolboxDeletion;
    private ui!: VFSUIShell;
    private view!: FileSystemView;
    private drawerActions!: DrawerActions;
    private titles = new Map<string, string>();
    private readonly abort = new AbortController();
    private readonly prefs: ToolboxPreferences;
    private readonly filters = document.createElement('div');
    private descriptions = new Map<string, { name: string; description?: string }>();
    private cleanups: Array<() => void | Promise<void>> = [];
    private readonly loadedDirectories = TOOLBOX_KINDS.map(kind => '/' + kind);
    private closed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private refreshTail: Promise<void> = Promise.resolve();
    constructor(private readonly options: Options) { this.prefs = preferences(this.options.uiPreferences?.load()); }
    async start(): Promise<void> {
        const { resources, sidebar } = this.options;
        sidebar.classList.add('toolbox-navigation');
        await resources.drawers.init();
        this.drawerActions = new DrawerActions({ groups: resources.drawers, signal: this.abort.signal,
            refresh: () => { this.ui.refreshList(); const active = this.ui.getSnapshot().activeId; if (active) this.revealDrawer(active); }, create: group => this.createResource({ drawerId: group.id }), title: path => this.titles.get(path) ?? path });
        this.view = createFileSystemView({ viewId: 'toolbox:admin', mounts: TOOLBOX_KINDS.map(kind => ({
            mountId: kind, at: '/' + kind, fs: resources.sources[kind], access: ['prompts', 'mcp', 'tools', 'providers', 'connections'].includes(kind) ? 'ro' : 'rw' })) });
        this.descriptions = await resources.descriptions();
        await this.loadDirectories();
        this.buildFilters();
        this.ui = createVFSUI({ sessionListContainer: sidebar, title: t('toolbox.title'), scopeId: TOOLBOX_SCOPE, persistence: presentationPersistence(this.options.uiPersistence), autoSelectFirst: false,
            appearance: { showTimestamp: false, menuVisibility: 'always' },
            searchPlaceholder: t('toolbox.search'), listHeader: this.filters, listItems: items => this.project(items),
            alwaysLoadedDirectories: this.loadedDirectories,
            defaultUiSettings: { showSummary: true, showTags: true, showBadges: false, sortBy: 'title' },
            fileCreation: { resolveParent: path => path ?? (['agents', 'flows'].includes(this.prefs.filter) ? '/' + this.prefs.filter : null) },
            sort: { by: 'title', direction: 'asc', directoriesFirst: true },
            compareItems: compareModelItems,
            contextMenu: { items: (item, defaults) => this.menu(item, defaults), bulkItems: (items, defaults) => this.bulkMenu(items, defaults) },
        }, this.view);
        this.connectSources();
        await this.ui.start(); this.setFilter(this.prefs.filter, false);
    }
    private connectSources(): void {
        const { resources, editor } = this.options;
        this.deletion = new ConfigurationDeletionDialog(this.options.configuration, () => this.refresh(), this.options.ocr?.deletionImpact, this.options.projects);
        this.selectionDeletion = new ToolboxDeletion({ resources, inventory: this.options.inventory, view: this.view, deletion: this.deletion,
            completed: async () => { if (!this.closed) { this.ui.setSelection([]); await this.refresh(); } } });
        this.cleanups.push(connectEditorLifecycle(this.ui, this.view, editor, undefined, { emptyMessage: t('toolbox.empty'), files: { fs: this.view, cwd: '/' }, resolveEditor: node => this.factory(toolboxKind(node.id)!),
            hostContext: { navigate: this.options.navigate } }));
        this.cleanups.push(this.ui.on('sessionSelected', ({ item }) => this.selected(item?.id ?? null)));
        this.cleanups.push(resources.subscribe(() => this.scheduleRefresh()));
        for (const [kind, source] of Object.entries(resources.sources)) if (drawerKind(kind as ToolboxKind)) {
            const changed = (event: { payload: { nodes: Array<{ oldPath: string; newPath: string }> } }) => {
                void resources.drawers.relocate(kind as import('@itookit/app-contracts').DrawerKind, event.payload.nodes)
                    .then(() => this.scheduleRefresh()).catch(error => alert(String(error)));
            };
            this.cleanups.push(source.on('node:renamed', changed), source.on('node:moved', changed));
        }
        for (const source of Object.values(resources.sources)) this.cleanups.push(source.on('node:updated', () => this.scheduleRefresh()),
            source.on('node:created', () => this.scheduleRefresh()), source.on('node:deleted', () => this.scheduleRefresh()));
    }

    private factory(kind: ToolboxKind): EditorFactory {
        return async (container, options) => {
            const original = editorResourceId(options) ?? '', path = toolboxSourcePath(original), source = this.options.resources.sources[kind];
            const target = kind !== 'agents' && kind !== 'flows'
                ? { kind: 'entity' as const, entityType: { prompts: 'system-prompt' as const, skills: 'skill' as const, mcp: 'mcp' as const, tools: 'tool' as const, providers: 'provider' as const, connections: 'connection' as const }[kind], id: decodeURIComponent(path.slice(1)) }
                : { kind: 'file' as const, path };
            const instance = await this.options.factories[kind](container, { ...options, target, files: { fs: source, cwd: '/' },
                hostContext: { ...options.hostContext!, navigate: this.options.navigate, requestDelete: targets => this.deletion.request(targets), saveContent: (id, content) => source.driver.writeContent(toolboxSourcePath(id), content) } });
            const update = instance.updateNodeId?.bind(instance);
            if (update) instance.updateNodeId = id => update(toolboxSourcePath(id));
            return instance;
        };
    }
    private buildFilters(): void {
        this.filters.className = 'toolbox-filters'; this.filters.setAttribute('role', 'group'); this.filters.setAttribute('aria-label', t('toolbox.filters'));
        for (const kind of TOOLBOX_FILTERS) {
            const button = document.createElement('button'); button.type = 'button'; button.dataset.filter = kind;
            button.textContent = t(`toolbox.${kind}`); button.onclick = () => this.setFilter(kind); this.filters.append(button);
        }
    }
    setFilter(filter: ToolboxFilter, remember = true): void {
        if (this.ui && remember) this.prefs.queries[this.prefs.filter] = this.ui.getSnapshot().query;
        this.prefs.filter = filter;
        for (const button of this.filters.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
        this.ui?.setSelection([]);
        this.ui?.setQuery(this.prefs.queries[filter] ?? '');
        this.ui?.refreshList(); this.updateToolbar(); this.persist();
    }
    private updateToolbar(): void {
        this.ui?.setToolbar({ fileLabel: t('toolbox.new'),
            secondary: this.prefs.filter === 'models' ? (this.options.ocr ? { label: t('ocr.configure'), run: async () => { await this.options.ocr!.configure(); } } : undefined) : { label: t('toolbox.organize'), run: () => { const group = this.selectedDrawer();
                const kind = group?.kind ?? (drawerKind(this.prefs.filter as ToolboxKind) ? this.prefs.filter as import('@itookit/app-contracts').DrawerKind : 'agents');
                void this.drawerActions.move(kind, group?.paths).catch(error => alert(String(error))); } },
            hiddenActions: this.prefs.filter === 'tools' ? ['create-file', 'create-directory']
                : ['create-directory'],
            actions: { 'create-file': async () => { await this.createResource(); }, import: context => this.import(context), export: context => this.export(context) } });
    }
    private project(items: VFSNodeUI[]): VFSNodeUI[] {
        const roots = items;
        const decorate = (nodes: VFSNodeUI[]): VFSNodeUI[] => nodes.filter(node =>
            !node.id.startsWith('/agents/system-prompts') && (node.type === 'directory' || toolboxKind(node.id) !== 'agents' || node.id.endsWith('.agent'))).map(node => {
            const kind = toolboxKind(node.id)!;
            const id = node.id.split('/').pop()!.replace(/\.(agent|flow)$/i, '');
            const description = this.descriptions.get(kind + '/' + id);
            const summary = description?.description ?? String(node.metadata.custom.description ?? '');
            const source = String(node.metadata.custom.source ?? '');
            this.titles.set(node.id, description?.name ?? node.metadata.title);
            return { ...node, icon: this.itemIcon(node, kind), children: node.children && decorate(node.children),
                metadata: { ...node.metadata, title: description?.name ?? node.metadata.title,
                    tags: node.metadata.tags, custom: { ...node.metadata.custom, toolboxKind: kind, navigationMenu: true } },
                content: node.type === 'file' ? { ...node.content!, summary: [['connections', 'tools'].includes(kind) ? '' : source, summary.split('\n')[0].slice(0, 160)].filter(Boolean).join(' · '), searchableText: [source, summary, id].join(' ') } : node.content };
        });
        const decorated = decorate(roots.flatMap(node => node.children ?? []).flatMap(node =>
            node.id === '/agents/default' ? node.children ?? [] : [node]));
        return this.groupResources(decorated);
    }
    private itemIcon(node: VFSNodeUI, kind: ToolboxKind): string | undefined {
        if (node.metadata.custom.remoteHarnessAgent) return ENTITY_ICONS.remoteAgent;
        if (node.type !== 'file') return node.icon;
        return kind === 'mcp' ? mcpStatusIcon(node.metadata.custom) : resourceIcon(kind);
    }
    private groupResources(items: VFSNodeUI[]): VFSNodeUI[] {
        const models = items.filter(item => ['providers', 'connections'].includes(toolboxKind(item.id)!));
        return [...(this.prefs.filter === 'all' || this.prefs.filter === 'models' ? modelDrawers(models, this.options.inventory) : []),
            ...resourceDrawers(items, this.options.inventory, this.options.resources.drawers, this.prefs.filter)];
    }

    private async loadDirectories(): Promise<void> {
        const directories = TOOLBOX_KINDS.map(kind => '/' + kind);
        for (const kind of ['agents', 'flows'] as const) {
            const walk = async (path: string): Promise<void> => {
                for (const node of await this.options.resources.sources[kind].driver.getChildren(path)) {
                    if (node.type !== 'directory' || node.name.startsWith('.') || node.name === 'system-prompts') continue;
                    directories.push('/' + kind + node.path); await walk(node.path);
                }
            };
            await walk('/');
        }
        await this.options.resources.refreshGroups(defaultToolDrawers(this.options.inventory));
        this.loadedDirectories.splice(0, this.loadedDirectories.length, ...directories);
    }
    private exportMenu(ids: string[]): MenuItem<VFSNodeUI> {
        return { id: 'export-json', label: t('toolbox.exportJSON'), onClick: async () => {
            downloadArchive(await this.exportSelection(ids), 'toolbox.json');
        } };
    }
    private menu(item: VFSNodeUI, defaults: MenuItem<VFSNodeUI>[]): MenuItem<VFSNodeUI>[] {
        const kind = toolboxKind(item.id), provider = modelDrawerProvider(item.id);
        const actions = [this.exportMenu([item.id])];
        if (provider !== undefined) return [...this.modelMenu(provider), ...actions];
        if (kind === 'connections') {
            const id = decodeURIComponent(toolboxSourcePath(item.id).slice(1));
            const current = this.options.inventory.defaultConnectionId === id;
            actions.push({ id: 'default-connection', label: t(current ? 'connection.clearDefault' : 'connection.setDefault'),
                onClick: async () => { await this.options.resources.setDefaultConnection(current ? null : id); } });
        }
        const drawers = this.drawerActions.menu(item);
        if (kind === 'prompts' || kind === 'mcp' || kind === 'connections'
            || kind === 'providers')
            actions.push(this.deleteMenu(item.id));
        if (!kind || ['prompts', 'mcp', 'tools', 'providers', 'connections'].includes(kind)) return [...drawers, ...actions];
        const kept = defaults.filter(entry => 'id' in entry && ['rename', 'delete'].includes(entry.id));
        return [...drawers, ...actions, ...(kind === 'flows' ? this.options.flowMenu.items?.(item, kept) ?? kept : kept)];
    }
    private modelMenu(id: string): MenuItem<VFSNodeUI>[] {
        const provider = this.options.resources.hasProvider(id), path = '/providers/' + encodeURIComponent(id);
        if (!provider) return [];
        const menu: MenuItem<VFSNodeUI>[] = [{ id: 'provider-settings', label: t('toolbox.providerSettings'),
            onClick: () => { void this.openResource(path).catch(error => alert(String(error))); } }];
        menu.push(this.deleteMenu(path));
        return menu;
    }
    private deleteMenu(path: string): MenuItem<VFSNodeUI> {
        const kind = toolboxKind(path), entityType = kind === 'prompts' ? 'system-prompt' : kind === 'providers' ? 'provider' : kind === 'connections' ? 'connection' : 'mcp';
        return { id: 'delete-resource', label: t(kind === 'providers' ? 'toolbox.deleteProvider' : 'action.delete'),
            onClick: () => this.deletion.request([{ kind: 'entity', entityType, id: decodeURIComponent(toolboxSourcePath(path).slice(1)) }]) };
    }
    private bulkMenu(items: VFSNodeUI[], defaults: MenuItem<VFSNodeUI>[]): MenuItem<VFSNodeUI>[] {
        const paths = items.map(item => item.id), kind = toolboxKind(paths[0] ?? '');
        const menu = [this.exportMenu(paths)];
        if (drawerKind(kind) && items.every(item => item.type === 'file' && toolboxKind(item.id) === kind))
            menu.unshift({ id: 'moveDrawer', label: t('toolbox.moveDrawer'), onClick: () => {
                void this.drawerActions.move(kind, paths).catch(error => alert(String(error)));
            } });
        if (items.some(item => item.kind === 'group') && this.selectionDeletion.allows(items)) {
            menu.push({ id: 'bulk-delete', label: t('action.delete'), onClick: async () => { await this.selectionDeletion.run(paths, this.abort.signal); } });
            return menu;
        }
        if (kind === 'prompts' && items.every(item => toolboxKind(item.id) === 'prompts'))
            menu.push({ id: 'delete-resource', label: t('action.delete'), onClick: () => this.deletion.request(paths.map(path => ({
                kind: 'entity', entityType: 'system-prompt', id: decodeURIComponent(toolboxSourcePath(path).slice(1)),
            }))) });
        if (items.every(item => item.type === 'file' && ['agents', 'skills', 'flows'].includes(toolboxKind(item.id) ?? '') && !item.metadata.custom._readOnly))
            menu.push(...defaults.filter(item => 'id' in item && item.id === 'bulk-delete'));
        return menu;
    }
    private selectedDrawer(): Drawer | undefined {
        const state = this.ui.getSnapshot(), path = [...state.selectedIds][0] ?? state.activeId ?? '';
        const group = this.options.resources.drawers.get(path) ?? this.options.resources.drawers.forPath(path);
        return group && (this.prefs.filter === 'all' || this.prefs.filter === group.kind) ? group : undefined;
    }
    private selected(path: string | null): void {
        this.options.selected(path);
    }
    private persist(): void { this.options.uiPreferences?.save(this.prefs); }
    private scheduleRefresh(): void {
        if (this.closed) return;
        clearTimeout(this.timer); this.timer = setTimeout(() => { void this.refresh().catch(error => alert(String(error))); }, 100);
    }
    private refresh(): Promise<void> {
        const work = this.refreshTail.then(async () => {
            if (this.closed) return;
            await this.options.inventory.refresh(); this.descriptions = await this.options.resources.descriptions();
            await this.loadDirectories();
            if (!this.closed) await this.ui.refresh();
        });
        this.refreshTail = work.catch(() => {}); return work;
    }
    async openResource(path: string): Promise<void> {
        const kind = toolboxKind(path);
        if (!kind) throw new Error('Invalid toolbox resource');
        if (path === '/' + kind) { this.setFilter(toolboxFilter(kind)); return; }
        if (toolboxFilter(kind) === 'models' && this.prefs.filter !== 'models') this.setFilter('models');
        if (this.prefs.filter !== 'all' && this.prefs.filter !== toolboxFilter(kind)) this.setFilter(toolboxFilter(kind));
        this.ui.setQuery('');
        this.revealDrawer(path);
        await this.ui.selectPath(path);
    }
    private revealDrawer(path: string): void {
        const id = decodeURIComponent(toolboxSourcePath(path).slice(1));
        const kind = toolboxKind(path);
        const provider = kind === 'providers' ? id : kind === 'connections' ? this.options.inventory.connections.get(id)?.providerId : undefined;
        const folderId = provider ? modelDrawerId(provider) : this.options.resources.drawers.forPath(path)?.id;
        if (!folderId) return;
        this.ui.setExpanded(folderId, true);
    }
    async createResource(options: { title?: string; parentPath?: string | null; content?: string; drawerId?: string } = {}): Promise<string> {
        let created = '';
        const drawer = (options.drawerId ? this.options.resources.drawers.get(options.drawerId) : undefined) ?? this.selectedDrawer();
        const select = document.createElement('select');
        for (const kind of TOOLBOX_KINDS.filter(kind => kind !== 'tools')) { const option = document.createElement('option'); option.value = kind; option.textContent = t(`toolbox.${kind}`); select.append(option); }
        select.value = drawer && drawer.kind !== 'tools' ? drawer.kind : this.prefs.filter === 'models' ? 'connections' : this.prefs.filter !== 'all' && this.prefs.filter !== 'tools' ? this.prefs.filter : 'agents';
        const label = document.createElement('label'); label.textContent = t('toolbox.type'); label.append(select);
        const { field, providers } = this.providerField();
        const picker = drawerField(this.options.resources.drawers);
        const fields = document.createElement('div'); fields.append(label, field, picker.field);
        const update = () => { const kind = select.value as ToolboxKind; field.hidden = kind !== 'connections'; picker.field.hidden = !drawerKind(kind);
            if (drawerKind(kind)) picker.update(kind, drawer?.kind === kind ? drawer.name : ''); };
        select.onchange = update; update();
        await showNameDialog(t('toolbox.create'), t('toolbox.name'), this.abort.signal, async name => {
            created = await this.options.resources.createInDrawer(select.value as ToolboxKind, name, picker.input.value, select.value === 'connections' ? providers.value : undefined);
            await this.refresh(); await this.openResource(created);
        }, fields, { initialName: options.title });
        return created;
    }
    private providerField(): { field: HTMLLabelElement; providers: HTMLSelectElement } {
        const field = document.createElement('label'); field.textContent = t('toolbox.providers');
        const providers = document.createElement('select'); providers.name = 'providerId'; field.append(providers);
        for (const provider of [...this.options.inventory.providers.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
            const option = document.createElement('option'); option.value = provider.id; option.textContent = provider.name; providers.append(option);
        }
        const state = this.ui.getSnapshot(), path = [...state.selectedIds][0] ?? state.activeId ?? '';
        const id = decodeURIComponent(toolboxSourcePath(path).slice(1));
        const selected = modelDrawerProvider(path) ?? (toolboxKind(path) === 'providers' ? id : this.options.inventory.connections.get(id)?.providerId);
        if (selected && this.options.inventory.providers.has(selected)) providers.value = selected;
        return { field, providers };
    }
    private async export(context: VFSToolbarContext): Promise<void> {
        downloadArchive(await this.exportSelection(context.selectedIds), 'toolbox.json');
    }
    async exportSelection(ids: string[]): Promise<string> {
        if (!ids.length) throw new Error(t('toolbox.selectExport'));
        const paths = toolboxSelectionPaths(ids, this.options.resources, this.options.inventory);
        const drawers = ids.flatMap(id => { const group = this.options.resources.drawers.get(id);
            return group && group.id !== ungroupedId(group.kind) ? [{ kind: group.kind, name: group.name }] : []; });
        return this.options.resources.export(paths, drawers);
    }
    private async import(_context: VFSToolbarContext): Promise<void> {
        const file = await chooseArchive(this.abort.signal); if (!file || this.closed) return;
        const content = await file.text(); if (this.closed) return;
        const paths = await this.options.resources.import(content);
        await this.refresh(); if (!this.closed && paths[0]) await this.openResource(paths[0]);
    }
    getActiveResourceId(): string | null { return this.ui?.getActiveSession()?.id ?? null; }
    async destroy(): Promise<void> {
        this.closed = true; clearTimeout(this.timer); this.abort.abort();
        this.prefs.queries[this.prefs.filter] = this.ui?.getSnapshot().query ?? ''; this.persist();
        for (const close of this.cleanups.reverse()) await close();
        await this.refreshTail; this.ui?.destroy(); await this.view?.dispose();
        this.options.sidebar.classList.remove('toolbox-navigation');
    }
}
