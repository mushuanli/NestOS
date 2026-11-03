import {navigateWorkspaceBack} from '../navigation/page-history';
import { createNestOSVFSUI as createVFSUI } from '../browser/vfs-presentation';
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
import { t, ACTION_ICONS, createModuleLogger, randomUUID, NavigationRequest} from '@itookit/common';
import { EditorOptions, IEditor, EditorHostContext } from '@itookit/ui-common-adapter';
import {FSError} from '@itookit/vfs-core';
import type {StudyDraft} from '@itookit/mdxeditor';
import type { IFileSystem } from '@itookit/vfs-core';
import { showNameDialog } from '../files/project-dialog';
import { presentationPersistence } from '../persistence/initial-navigation';
import {ViewRefresh} from '../lifecycle/view-refresh';

const eventLog = createModuleLogger('workbench-events');

export class Workbench {
    private readonly dialogs = new AbortController();
    private createdStudyDrafts = new Map<string, {path: string; signature: string}>();
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
    private eventRefreshStarted = 0;
    private readonly eventRefresh = new ViewRefresh({visible: () => this.visible,
        run: async () => {this.eventRefreshStarted = Date.now(); await this.refresh(); await this.lifecycleUnsubscribe.refreshDirectory();},
        report: error => {
            const code = (error as {code?: unknown})?.code;
            eventLog.warn('events.refresh', {operationId: randomUUID(), stage: 'navigation', result: 'failure', durationMs: Date.now() - this.eventRefreshStarted,
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'VIEW_REFRESH_FAILED'});
        }});

    constructor(private config: WorkbenchConfig) {
        this.engine = config.files.fs;
        const changed = () => { this.dirty = true; };
        const stops = this.engine.onAny ? [this.engine.onAny(changed)]
            : (['node:created', 'node:updated', 'node:deleted', 'node:moved', 'node:renamed'] as const).map(type => this.engine.on(type, changed));
        this.stopChanges = () => stops.forEach(stop => stop());

        this.baseEditorFactory = config.editorFactory ?? defaultEditorFactory;

        const scopeId = config.scopeId || this.engine.viewId;
        const study = config.editorConfig?.plugins?.includes('cloze:cloze') === true;

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
                    compactLayout: 'inline', primaryAction: 'create-file', inlineActions: ['create-file', 'create-directory', 'open-root'],
                    overflowActions: [...(config.uiOptions?.toolbarOptions?.overflowActions ?? []), 'refresh', 'import', 'export', ...(study ? ['study'] : [])],
                    ...(config.uiOptions?.readOnly ? {hiddenActions: [...(config.uiOptions.toolbarOptions?.hiddenActions ?? []), 'create-file', 'create-directory', 'import']} : {}),
                    extraItems: [...(config.uiOptions?.toolbarOptions?.extraItems ?? []), ...(study ? [{ id: 'study', label: t('editor.study'), iconHTML: ACTION_ICONS.anki, placement: 'overflow' as const, after: 'refresh' }] : [])],
                    actions: { ...config.uiOptions?.toolbarOptions?.actions, ...(study ? { study: async () => this.openStudy() } : {}) },
                    root: { label: '/', title: `${t('workbench.directoryPath')}: /`, run: () => this.openDirectory('/') } },
                deferExpansion: config.uiOptions?.deferExpansion ?? true,
                listItems: config.uiOptions?.listItems,
                rowCreation: config.uiOptions?.rowCreation ?? { visible: () => config.uiOptions?.readOnly !== true, run: (node, type) => this.createInDirectory(node.id, type) },
            },
            this.engine
        ) as VFSUIShell;

        const sharedHostContext: EditorHostContext = {
            chatFromFile: config.chatFromFile,
            toggleSidebar: (_collapsed?: boolean) => navigateWorkspaceBack(config.editorContainer, () => this.vfsUI.toggleSidebar()),
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
                directoryActions: study ? [{id: 'study', label: t('editor.study'), icon: ACTION_ICONS.anki, run: () => this.openStudy()}] : [],
                virtualViews: study ? [{ id: '@study', title: t('editor.study'), icon: ACTION_ICONS.anki, preview: false,
                    create: async container => (await import('@itookit/mdx-adapter')).createStudyEditor(container, this.engine,
                        path => this.openFileInternal(path), config.uiOptions?.readOnly || config.editorConfig?.readOnly || config.editorConfig?.canCreateEntries === false ? {} : {
                            creation: {generation: config.studyGeneration?.generation, prompts: config.studyGeneration?.prompts, sources: config.studyGeneration?.sources, recovery: config.studyGeneration?.recovery,
                                label: t('editor.studyCreate'), documents: {save: draft => this.createStudyFile(draft)}},
                        }) }] : [],
                windows: config.windows,
                navigationLabel: config.uiOptions?.title ?? t('project.files'),
                onBeforeNavigate: config.onBeforeNavigate,
                onResourceRelocated: path => (config.onResourceRelocated ?? config.onSessionChange)?.(path),
                fileTypes: config.fileTypes,
                resolveEditor: resolveFileEditor(config.fileTypes, config.customEditorResolver),
                hostContext: sharedHostContext,
                files: config.files, sidebarContainer: config.sidebarContainer, workbenchState: config.workbenchState,
                ...config.editorConfig
            }
        );

        this.bindEvents();
    }

    assertRecovery(): void { this.lifecycleUnsubscribe.assertRecovery(); }
    captureRecovery(): unknown { return this.lifecycleUnsubscribe.captureRecovery(); }
    restoreRecovery(state: unknown): void { this.lifecycleUnsubscribe.restoreRecovery(state); }
    suspendForRecovery(): void { this.lifecycleUnsubscribe.suspendForRecovery(); }

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

    private async createStudyFile(draft: StudyDraft): Promise<{label: string}> {
        const operationId = draft.operationId, started = Date.now(), log = createModuleLogger('study-documents');
        let stage = 'validate';
        try {
            if (!draft.title.trim() || /[\\/]/.test(draft.title)) throw new FSError('EINVAL', t('editor.studyInvalidName'));
            const parentPath = draft.parent?.id ?? '/';
            if ((await this.engine.capabilitiesAt(parentPath)).readonly) throw new FSError('EROFS', t('vfs.creation.readOnly'));
            const signature = JSON.stringify([draft.title, parentPath, draft.content]);
            let receipt = this.createdStudyDrafts.get(operationId);
            if (receipt && receipt.signature !== signature) throw new FSError('EEXIST', t('editor.studyAlreadyCreated'));
            if (!receipt) {
                stage = 'create';
                const node = await this.vfsUI.sessionService.createFile({title: draft.title, parentPath, content: draft.content});
                receipt = {path: node.path, signature}; this.createdStudyDrafts.set(operationId, receipt);
            }
            void Promise.resolve().then(() => this.config.studyGeneration?.documentSaved?.(draft)).catch(error => {
                const raw = (error as {code?: unknown})?.code;
                const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'STUDY_SAVE_NOTIFICATION_FAILED';
                log.warn('study.create', {operationId, stage: 'notify-saved', result: 'failure', code, durationMs: Date.now() - started});
            });
            this.createdStudyDrafts.delete(operationId);
            log.info('study.create', {operationId, stage: 'complete', result: 'success', durationMs: Date.now() - started});
            return {label: receipt.path};
        } catch (error) {
            log.error('study.create', {operationId, stage, result: 'failure', code: error instanceof FSError ? error.code : 'STUDY_CREATE_FAILED', durationMs: Date.now() - started});
            throw error;
        }
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
    private async openStudy(): Promise<void> {
        const operationId = randomUUID(), started = Date.now(), log = createModuleLogger('study-navigation');
        try {
            await this.openFileInternal('@study');
            log.info('study.open', {operationId, stage: 'activate', result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.error('study.open', {operationId, stage: 'activate', result: 'failure', code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'STUDY_NAVIGATION_FAILED', durationMs: Date.now() - started}); throw error;
        }
    }

    private async openFileInternal(nodeId: string, mode?: 'edit' | 'render'): Promise<void> {
        if (nodeId === '/') { await this.openDirectory(nodeId); return; }
        await this.lifecycleUnsubscribe.openResource(nodeId, mode);
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
        if (!visible) {this.eventRefresh.pause(); if (this.refreshing) this.dirty = true;}
        this.visible = visible; this.vfsUI.setVisible(visible && this.navigationVisible);
        await this.lifecycleUnsubscribe.setVisible(visible);
        if (visible && this.eventRefresh.dirty) await this.eventRefresh.flush();
        else if (visible && this.navigationVisible && (this.dirty || this.engine.revision !== this.loadedRevision || performance.now() - this.loadedAt >= 15000)) await this.refresh();
    }

    public expandNavigation(): void {
        if (this.config.sidebarContainer.classList.contains('is-collapsed')) this.vfsUI.toggleSidebar();
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

    public invalidateFromEvents(): void {
        if (this.dialogs.signal.aborted) return;
        this.dirty = true;
        this.eventRefresh.mark('events');
    }

    public async destroy(): Promise<void> {
        this.dialogs.abort(); this.stopChanges();
        await this.eventRefresh.close();
        await this.lifecycleUnsubscribe();
        await this.navigationTask?.catch(() => {});
        this.vfsUI.destroy();
    }
}
