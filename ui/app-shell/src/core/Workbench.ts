import {backToPreviousPage} from '../navigation/page-history';
import { createMindOSVFSUI as createVFSUI } from '../browser/vfs-presentation';
import { connectEditorLifecycle } from '../browser/editor-connector';
import { resolveFileEditor } from '../browser/types';
import { createVFSMentionProviders } from '../browser/mention/createVFSMentionProviders';
/**
 * @file app-shell/core/Workbench.ts
 *
 * 工作区装配器 — 粘合 VFS-UI (侧边栏) + Editor (编辑器)。
 * 不创建 DOM，不拥有布局。消费方负责创建 sidebar/editor 容器并传入。
 */
import { VFSUIShell } from '@itookit/vfs-ui';
import { lazyMdxEditorFactory as defaultEditorFactory } from '../browser/lazy-mdx';
import type { WorkbenchConfig } from '../types';
import { t, NavigationRequest} from '@itookit/common';
import { EditorOptions, IEditor, EditorHostContext } from '@itookit/ui-common';
import type { IFileSystem } from '@itookit/vfs-core';
import { showNameDialog } from '../files/project-dialog';
import { presentationPersistence } from '../persistence/initial-navigation';

export class Workbench {
    private readonly dialogs = new AbortController();
    private vfsUI: VFSUIShell;
    private engine: IFileSystem;
    private lifecycleUnsubscribe: ReturnType<typeof connectEditorLifecycle>;
    private baseEditorFactory: (container: HTMLElement, options: EditorOptions) => Promise<IEditor>;
    private hasStarted = false;
    private navigationVisible = true;
    private navigationTask?: Promise<void>;
    private visible = true;
    private dirty = false;
    private refreshing = 0;
    private loadedRevision = 0;
    private loadedAt = 0;
    private readonly stopChanges: () => void;

    constructor(private config: WorkbenchConfig) {
        this.engine = config.files.fs;
        const changed = () => { this.dirty = true; };
        const stops = this.engine.onAny ? [this.engine.onAny(changed)]
            : (['node:created', 'node:updated', 'node:deleted', 'node:moved', 'node:renamed'] as const).map(type => this.engine.on(type, changed));
        this.stopChanges = () => stops.forEach(stop => stop());

        this.baseEditorFactory = config.editorFactory ?? defaultEditorFactory;

        const scopeId = config.scopeId || this.engine.viewId;

        this.vfsUI = createVFSUI(
            {
                ...config.uiOptions,
                scopeId,
                persistence: presentationPersistence(config.uiPersistence),
                sessionListContainer: config.sidebarContainer,
                fileCreation: {
                    ...config.uiOptions?.fileCreation,
                    instant: true,
                    startupFileName: config.uiOptions?.fileCreation?.startupFileName ?? config.defaultContentConfig?.fileName,
                    startupContent:  config.uiOptions?.fileCreation?.startupContent  ?? config.defaultContentConfig?.content,
                },
                fileTypes: config.fileTypes,
                showFileExtensions: config.showFileExtensions ?? true,
                appearance: { ...config.uiOptions?.appearance,
                    showTitle: config.uiOptions?.appearance?.showTitle ?? (!!config.uiOptions?.titleHeader || config.uiOptions?.toolbar === 'compact') },
                activateDirectories: true, autoSelectFirst: false,
                toolbarOptions: { ...config.uiOptions?.toolbarOptions,
                    root: { label: '/', title: `${t('workbench.directoryPath')}: /`, run: () => this.openDirectory('/') } },
                deferExpansion: config.uiOptions?.deferExpansion ?? true,
                listItems: config.uiOptions?.listItems,
                rowCreation: config.uiOptions?.rowCreation ?? { visible: () => config.uiOptions?.readOnly !== true, run: (node, type) => this.createInDirectory(node.id, type) },
            },
            this.engine
        ) as VFSUIShell;

        const sharedHostContext: EditorHostContext = {
            chatFromFile: config.chatFromFile,
            toggleSidebar: (_collapsed?: boolean) => {
                const layout = config.editorContainer.closest<HTMLElement>('.mm-layout');
                if (layout && window.matchMedia?.('(max-width: 768px)').matches) backToPreviousPage(() => {layout.dataset.mobileView = 'list';});
                else this.vfsUI.toggleSidebar();
            },
            saveContent: async (nodeId: string, content: string) => {
                await this.engine.driver.writeContent(nodeId, content);
            },
            navigate: async (req: NavigationRequest) => {
                if (this.config.onNavigate) {
                    await this.config.onNavigate(req);
                } else {
                    console.warn('[Workbench] onNavigate callback is missing in config.');
                }
            }
        };

        this.lifecycleUnsubscribe = connectEditorLifecycle(
            this.vfsUI,
            this.engine,
            config.editorContainer,
            this.enhancedEditorFactory,
            {
                navigationLabel: config.uiOptions?.title ?? t('project.files'),
                onBeforeNavigate: config.onBeforeNavigate,
                fileTypes: config.fileTypes,
                resolveEditor: resolveFileEditor(config.fileTypes, config.customEditorResolver),
                hostContext: sharedHostContext,
                files: config.files, sidebarContainer: config.sidebarContainer, workbenchState: config.workbenchState,
                ...config.editorConfig
            }
        );

        this.bindEvents();
    }

    private enhancedEditorFactory = async (
        container: HTMLElement,
        runtimeOptions: EditorOptions
    ): Promise<IEditor> => {
        const { editorConfig } = this.config;

        const mentionScope = editorConfig?.mentionScope;
        const mentionPlugin = mentionScope !== undefined
            ? new (await import('@itookit/mdxeditor')).MentionPlugin({
                providers: createVFSMentionProviders(this.engine, mentionScope),
                onMentionClick: (_providerKey: string, nodeId: string) => {
                    this.config.onNavigate?.({ target: 'self', action: 'open', resourceId: nodeId });
                },
            })
            : undefined;

        const basePlugins = [
            ...(editorConfig?.plugins || []),
            ...(runtimeOptions?.plugins || []),
        ];
        const plugins = mentionPlugin
            ? [...basePlugins.filter(p => p !== 'autocomplete:mention'), mentionPlugin]
            : basePlugins;

        const mergedOptions: EditorOptions = {
            ...editorConfig,
            ...runtimeOptions,
            plugins,
            defaultPluginOptions: {
                ...(editorConfig?.defaultPluginOptions || {}),
                ...(runtimeOptions?.defaultPluginOptions || {}),
            },
            files: this.config.files,
        };

        return this.baseEditorFactory(container, mergedOptions);
    }

    private bindEvents() {
        const unsubSidebar = this.vfsUI.on('sidebarStateChanged', ({ isCollapsed }) => {
            this.config.onSidebarToggle?.(isCollapsed);
        });

        this.vfsUI.on('sessionSelected', (payload: { item?: { id: string } }) => {
            const sessionId = payload.item?.id ?? null;
            if (this.config.onSessionChange) {
                this.config.onSessionChange(sessionId);
            }
        });

        const originalDestroy = this.destroy.bind(this);
        this.destroy = async () => {
            await originalDestroy();
            unsubSidebar();
        };
    }

    public async start(initialResourceId?: string): Promise<void> {
        this.loadedRevision = this.engine.revision;
        this.hasStarted = true;
        this.navigationVisible = !this.config.deferNavigation;
        if (this.navigationVisible) await this.setNavigationVisible(true);
        else this.vfsUI.setVisible(false);

        if (initialResourceId) {
            const currentId = this.getActiveFilePath();
            if (currentId !== initialResourceId) {
                await this.openFileInternal(initialResourceId);
            }
        }

        this.hasStarted = true; this.loadedAt = performance.now();
    }

    public async openFile(nodeId: string): Promise<void> {
        if (!this.hasStarted) {
            console.warn('[Workbench] openFile called before start, ignoring');
            return;
        }

        const currentId = this.getActiveFilePath();
        if (currentId === nodeId) {
            return;
        }

        await this.openFileInternal(nodeId);
    }

    public async createAndOpenFile(options: {
        title?: string;
        parentPath?: string | null;
        content?: string;
    } = {}): Promise<string> {
        if (!this.hasStarted) {
            console.warn('[Workbench] createAndOpenFile called before start');
            throw new Error('Workbench not started');
        }

        const title = options.title || 'Untitled';
        const newNode = await this.vfsUI.sessionService.createFile({
            title,
            parentPath: options.parentPath ?? null,
            content: options.content,
        });

        await new Promise(resolve => setTimeout(resolve, 50));

        const currentId = this.getActiveFilePath();
        if (currentId !== newNode.path) {
            await this.openFileInternal(newNode.path);
        }

        return newNode.path;
    }

    private async openDirectory(path: string): Promise<void> {
        await this.lifecycleUnsubscribe.openDirectory(path); this.config.onSessionChange?.(path);
    }
    private async createInDirectory(path: string, type: 'file' | 'directory'): Promise<void> {
        await showNameDialog(t(type === 'file' ? 'project.createFile' : 'project.createFolder'), t('project.newFileName'), this.dialogs.signal, async name => {
            if (type === 'file') await this.vfsUI.sessionService.createFile({ title: name, parentPath: path });
            else await this.vfsUI.sessionService.createDirectory({ title: name, parentPath: path });
            await this.vfsUI.refresh(); await this.openDirectory(path);
        });
    }
    private async openFileInternal(nodeId: string): Promise<void> {
        if (nodeId === '/') { await this.openDirectory(nodeId); return; }
        await this.lifecycleUnsubscribe.openResource(nodeId);
        this.config.onSessionChange?.(nodeId);
        if (this.navigationVisible) this.vfsUI.setSelection([nodeId]);
    }

    public setNodeWaitingInput(nodeId: string, waiting: boolean): void {
        this.vfsUI.setNodeAttention(nodeId, waiting ? t('project.waitingInput') : undefined);
    }

    /** @deprecated This is a file path, not a durable Session ID. */

    public getActiveFilePath(): string | null {
        return this.lifecycleUnsubscribe.getActiveResourceId();
    }

    public async setVisible(visible: boolean): Promise<void> {
        if (this.visible === visible) return;
        if (!visible && this.refreshing) this.dirty = true;
        this.visible = visible; this.vfsUI.setVisible(visible && this.navigationVisible);
        await this.lifecycleUnsubscribe.setVisible(visible);
        if (visible && this.navigationVisible && (this.dirty || this.engine.revision !== this.loadedRevision || performance.now() - this.loadedAt >= 15000)) await this.refresh();
    }

    public async setNavigationVisible(visible: boolean): Promise<void> {
        if (this.dialogs.signal.aborted) return;
        this.navigationVisible = visible; this.vfsUI.setVisible(visible && this.visible);
        if (!visible || !this.visible) return;
        if (!this.navigationTask) this.dirty = false;
        this.navigationTask ??= this.vfsUI.start().then(() => {}).catch(error => { this.navigationTask = undefined; throw error; });
        await this.navigationTask;
        if (this.dirty) await this.refresh();
        const id = this.getActiveFilePath(); if (id) this.vfsUI.setSelection([id]);
    }

    public async refresh(): Promise<void> {
        if (!this.navigationVisible || !this.visible) { this.dirty = true; return; }
        const revision = this.engine.revision; this.dirty = false; ++this.refreshing;
        try { await this.vfsUI.refresh(); this.loadedRevision = revision; this.loadedAt = performance.now(); }
        catch (error) { this.dirty = true; throw error; }
        finally { --this.refreshing; }
    }

    public async destroy(): Promise<void> {
        this.dialogs.abort(); this.stopChanges();
        await this.lifecycleUnsubscribe();
        await this.navigationTask?.catch(() => {});
        this.vfsUI.destroy();
    }
}
