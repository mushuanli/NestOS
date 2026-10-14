import type { MDxPlugin, MDxEditor, PluginContext, AssetConfigOptions } from '@itookit/mdxeditor';
import type { IFileSystem } from '@itookit/vfs-core';
import { ACTION_ICONS } from '@itookit/common';
import { Toast } from '@itookit/ui-common';
import { AssetManagerUI } from './asset-manager.ui';

export class AssetManagerPlugin implements MDxPlugin {
    name = 'ui:asset-manager';
    private ui?: AssetManagerUI;
    private disposed = false;
    constructor(private fs?: IFileSystem, private path: () => string | undefined = () => undefined,
        private assets?: IFileSystem, private options: AssetConfigOptions = {}) {}
    install(context: PluginContext): void {
        const open = () => this.open(context.pluginManager.editorInstance as MDxEditor);
        context.registerTitleBarButton?.({ id: 'asset-manager', title: '附件管理', icon: ACTION_ICONS.import,
            location: 'right', onClick: open });
        context.registerCommand?.('openAssetManager', open);
    }
    private async open(editor: MDxEditor): Promise<void> {
        const path = this.path();
        const dir = this.assets ? '/' : this.fs && path ? await this.fs.meta.assets.getAssetDirPath(path) : null;
        if (this.disposed) return;
        if (!dir) { Toast.info('暂无附件'); return; }
        this.ui?.close();
        this.ui = new AssetManagerUI(this.assets ?? this.fs!, editor, this.options);
        await this.ui.show(dir);
        if (this.disposed) this.ui?.close();
    }
    destroy(): void { this.disposed = true; this.ui?.close(); this.ui = undefined; }
}
