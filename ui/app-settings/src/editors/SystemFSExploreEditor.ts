import { t, traceBoot, fileTypeIcon, type LocaleKey } from '@itookit/common';
import type { IFileSystem } from '@itookit/vfs-core';
import type { EditorFactory, EditorOptions } from '@itookit/ui-common';
/**
 * @file SystemFSExploreEditor.ts
 * @desc Debug settings page — read-only view of all VFS modules.
 *
 * Layout (within the settings page):
 *   ┌─ settings page header ────────────────────────────────┐
 *   │  "System FS Explorer"   (read-only, debug)            │
 *   ├───────────────────────────────────────────────────────┤
 *   │ ┌── sidebar ──────┐ ┌── editor / viewer ───────────┐  │
 *   │ │ <module>/       │ │  MDX render of file content  │  │
 *   │ │   file.md       │ │                              │  │
 *   │ │   .hidden  ◁──▷ │ │  ⛔ hidden — content blocked  │  │
 *   │ └────────────────-┘ └──────────────────────────────┘  │
 *   └───────────────────────────────────────────────────────┘
 *
 * Hidden files (names starting with ".") are visible in the tree but their
 * content is replaced with a placeholder by SystemVFSEngine.readContent().
 */
import { BaseSettingsEditor } from '@itookit/ui-common';
import { createVFSUI, fromVFS, VFSUIShell } from '@itookit/vfs-ui';
import '@itookit/mdxeditor/style.css';

const defaultEditorFactory: EditorFactory = async (container, options) =>
    (await import('@itookit/mdx-adapter')).defaultEditorFactory(container, options);
import type { SettingsPort as SettingsService } from '@itookit/app-contracts/settings';
import { createSystemFileInspector } from './system-fs/system-file-inspector';

export type FileBrowserConnector = (browser: VFSUIShell, fs: IFileSystem, container: HTMLElement, factory: EditorFactory) => () => void;

export class SystemFSExploreEditor extends BaseSettingsEditor<SettingsService> {
    private inspector?: Awaited<ReturnType<typeof createSystemFileInspector>>;
    private vfsUI?: VFSUIShell;
    private lifecycleUnsub?: () => void;
    private isStructureInitialized = false;

    constructor(container: HTMLElement, service: SettingsService, options: EditorOptions, private readonly connectBrowser: FileBrowserConnector) {
        super(container, service, options);
    }

    async init(container: HTMLElement): Promise<void> {
        await super.init(container);
    }

    async render(): Promise<void> {
        if (this.isStructureInitialized) return;

        // ── Page skeleton ─────────────────────────────────────────────────────
        this.container.innerHTML = `
            <div class="settings-page sfe-page">
                <div class="settings-page__header">
                    <div>
                        <h2 class="settings-page__title">System FS Explorer</h2>
                        <p class="settings-page__description">
                            Read-only view of configured workspace files and device descriptions.
                        </p>
                    </div>
                    <span class="sfe-badge">debug / read-only</span>
                </div>
                <div id="sfe-mount" class="sfe-mount"></div>
            </div>
        `;

        const mount = this.container.querySelector('#sfe-mount') as HTMLElement;

        // ── Engine: cross-module read-only VFS view ───────────────────────────
        this.inspector = await createSystemFileInspector(this.service.workspaces, this.service.vfs.devices.list().map(id => this.service.vfs.devices.get(id)));
        const engine = this.inspector.fs;

        // ── Layout DOM ──────────────────────────────────────────────────────
        const layoutEl = document.createElement('div');
        layoutEl.className = 'mm-layout';

        const sidebarEl = document.createElement('div');
        sidebarEl.className = 'mm-sidebar';

        const editorEl = document.createElement('div');
        editorEl.className = 'mm-editor-area';

        layoutEl.appendChild(sidebarEl);
        layoutEl.appendChild(editorEl);
        mount.appendChild(layoutEl);

        // ── VFSUIShell + editor lifecycle ───────────────────────────────────
        this.vfsUI = createVFSUI(
            {
                source: fromVFS(engine),
                readOnly: true,
                title: 'Files',
                searchPlaceholder: 'Search files…',
                initialSidebarCollapsed: false,
                // A read-only inspection surface: remember nothing between visits.
                persistence: false,
                sessionListContainer: sidebarEl,
                presentation: { translate: (key, params) => t(key as LocaleKey, params), trace: traceBoot, fileIcon: fileTypeIcon },
            },
            engine,
        ) as VFSUIShell;

        this.lifecycleUnsub = this.connectBrowser(
            this.vfsUI,
            engine,
            editorEl,
            defaultEditorFactory,
        );

        await this.vfsUI.start();
        this.isStructureInitialized = true;
    }

    async destroy(): Promise<void> {
        this.lifecycleUnsub?.();
        this.vfsUI?.destroy();
        this.vfsUI = undefined;
        this.lifecycleUnsub = undefined;
        this.isStructureInitialized = false;
        await this.inspector?.dispose();
        this.inspector = undefined;
        await super.destroy();
    }
}
