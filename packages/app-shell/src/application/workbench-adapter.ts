import { createFileSystemSource, type FileSystemSourceOwner } from '@itookit/vfs-core';
import { FILE_BROWSER_ICONS, VFS_TOOLBAR_ICONS, t } from '@itookit/common';
import type { EditorFactory } from '@itookit/ui-common';
import type { VFSActionDefinition, MenuItem } from '@itookit/vfs-ui';
import type { ApplicationCapabilities } from '@itookit/app-core/application/contracts';
import { Workbench } from '../core/Workbench';
import type { WorkbenchConfig } from '../types';
import { ApplicationFileBackend, sessionId, sessionPath } from './file-backend';
import { ApplicationConversationControls } from './conversation-controls';
import type { ApplicationView, ApplicationViewContext } from './shell';

/** Adapt host capabilities to the existing workbench; no separate sidebar or tab UI. */
export function createApplicationWorkbench(context: ApplicationViewContext): ApplicationView {
    return new WorkbenchPortAdapter(context);
}
class WorkbenchPortAdapter implements ApplicationView {
    private readonly chat: boolean;
    private readonly controls = new Map<string, ApplicationConversationControls>();
    private owner?: FileSystemSourceOwner;
    private workbench?: Workbench;
    private visible = true;
    private active: string | null = null;
    private unsubscribe?: () => void;
    private closed = false;
    constructor(private readonly context: ApplicationViewContext) { this.chat = context.workspace.type === 'chat'; }
    private activate = (path: string | null): void => {
        this.active = path;
        for (const [id, port] of this.controls) port.setVisible(this.visible && id === path);
    };
    private factory: EditorFactory = async (container, options) => {
        const path = options.target?.kind === 'file' ? options.target.path : undefined;
        const id = this.chat && path ? sessionId(path) : undefined;
        if (!id || !path) return this.context.presentation.file(container, options);
        const port = new ApplicationConversationControls(this.context.application, id, this.context.drafts);
        this.controls.set(path, port); port.setVisible(this.visible && path === this.active);
        try {
            const editor = await this.context.presentation.conversation(container, port, { ...options, files: undefined, target: { kind: 'session', sessionId: id } });
            const destroy = editor.destroy.bind(editor);
            editor.destroy = async () => { await destroy(); await port.close(); this.controls.delete(path); };
            return editor;
        } catch (error) { this.controls.delete(path); await port.close(); throw error; }
    };
    private create = async (folder: string | null): Promise<void> => {
        const result = await this.context.application.command('createConversation', { title: t('project.createSession'), folder });
        await this.workbench!.refresh(); await this.workbench!.openFile(sessionPath(result.sessionId, folder));
    };
    async start(): Promise<void> {
        const capabilities = await this.context.application.query('capabilities', undefined);
        this.owner = await createFileSystemSource({ backend: new ApplicationFileBackend(this.context.application,
            this.chat ? undefined : { kind: 'workspace', name: this.context.workspace.workspaceName }),
            viewId: `application:${this.context.workspace.slug}`, tags: false });
        this.workbench = new Workbench(this.config(capabilities));
        this.unsubscribe = this.context.application.subscribe(event => {
            if (this.visible && !this.closed && event.kind === 'invalidate' && (event.scope === 'all' || event.scope === (this.chat ? 'sessions' : 'files')))
                void this.workbench!.refresh().catch(this.report);
        });
        await this.workbench.start();
    }
    private config(capabilities: ApplicationCapabilities): WorkbenchConfig {
        const canCreate = this.chat && capabilities.commands.includes('createConversation');
        return { files: { fs: this.owner!.fs, cwd: '/' }, sidebarContainer: this.context.sidebar, editorContainer: this.context.editor,
            editorFactory: this.factory, showFileExtensions: !this.chat, onSessionChange: this.activate,
            editorConfig: { refreshFileMetadata: false, canCreateEntries: false, readOnly: !this.chat && !capabilities.commands.includes('saveFile') },
            uiOptions: { title: this.context.workspace.title, readOnly: true, hideGitignored: !this.chat,
                contextMenu: { items: (_node, defaults) => unavailableMenu(defaults), bulkItems: (_nodes, defaults) => unavailableMenu(defaults) },
                toolbar: 'full', toolbarOptions: { definitions: toolbarActions(this.chat, canCreate, this.create, () => this.workbench!.refresh()) } } };
    }
    async open(id: string): Promise<void> {
        if (this.closed) throw new Error('Application view is closed');
        if (this.chat && id.startsWith('session:')) {
            const session = await this.context.application.query('session', { sessionId: id.slice(8) });
            id = sessionPath(session.id, session.folder);
        }
        await this.workbench!.openFile(id);
    }
    async setVisible(next: boolean): Promise<void> {
        this.visible = next; this.activate(this.active); await this.workbench?.setVisible(next);
    }
    async close(): Promise<void> {
        if (this.closed) return;
        await this.workbench?.destroy(); this.closed = true; this.unsubscribe?.(); await this.owner?.dispose();
        for (const port of this.controls.values()) await port.close(); this.controls.clear();
    }
    private report = (error: unknown): void => {
        if (this.closed) return;
        console.warn('[Application] Workbench refresh failed', error);
        const status = document.createElement('p'); status.setAttribute('role', 'alert');
        status.textContent = error instanceof Error ? error.message : String(error); this.context.editor.append(status);
    };
}

function unavailableMenu(items: MenuItem[]): MenuItem[] {
    return items.map(item => item.type === 'separator' ? item : { ...item, disabled: true });
}

function toolbarActions(chat: boolean, canCreate: boolean, create: (parent: string | null) => Promise<void>, refresh: () => Promise<void>): VFSActionDefinition[] {
    const unavailable = async () => {};
    return [
        { id: 'create-file', label: t(chat ? 'project.createSession' : 'project.createFile'), iconHTML: FILE_BROWSER_ICONS.addFile,
            placement: 'toolbar', disabled: () => !canCreate, run: async context => create(context.parentPath === '/' ? null : context.parentPath) },
        { id: 'create-directory', label: t('project.createFolder'), iconHTML: FILE_BROWSER_ICONS.addFolder, placement: 'toolbar', disabled: () => true, run: unavailable },
        { id: 'refresh', label: t('vfs.toolbar.refresh'), iconHTML: FILE_BROWSER_ICONS.refresh, placement: 'toolbar', run: refresh },
        { id: 'import', label: t('vfs.toolbar.import'), iconHTML: VFS_TOOLBAR_ICONS.import, placement: 'toolbar', disabled: () => true, run: unavailable },
        { id: 'export', label: t('vfs.toolbar.export'), iconHTML: VFS_TOOLBAR_ICONS.export, placement: 'toolbar', disabled: () => true, run: unavailable },
    ];
}
