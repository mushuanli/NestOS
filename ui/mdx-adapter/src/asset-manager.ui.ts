/**
 * @file mdx/plugins/ui/asset-manager.ui.ts
 * @desc 独立的资源管理器 UI 类，不绑定 MDxPlugin 上下文
 */
import { Toast } from '@itookit/ui-common';
import { guessMimeType, type IFileSystem, type FSNode, type FSFileNode } from '@itookit/vfs-core';
import type { MDxEditor } from '@itookit/mdxeditor';
import {
    isAssetVisible,
    generateAssetPath,
    extractFilenameFromPath,
    AssetConfigOptions
} from '@itookit/mdxeditor';

interface AssetDisplayItem {
    node: FSNode;
    isUsed: boolean;
    url?: string;
}

export class AssetManagerUI {
    private objectUrls: string[] = [];
    private overlay: HTMLElement | null = null;
    private listContainer!: HTMLElement;
    private statsEl!: HTMLElement;
    private cleanBtn!: HTMLElement;
    private currentAssetDirPath: string = '';
    private escHandler: ((event: KeyboardEvent) => void) | null = null;

    constructor(
        private engine: IFileSystem,
        private editor: MDxEditor | null,
        private options: AssetConfigOptions = {}
    ) { }

    public async show(assetDirPath: string): Promise<void> {
        this.currentAssetDirPath = assetDirPath;
        this.createModalStructure();

        if (this.overlay) {
            document.body.appendChild(this.overlay);
        }

        try {
            await this.refreshAssetList();
        } catch (e) {
            console.error('[AssetManager] Load failed:', e);
            Toast.error('加载附件列表失败');
            this.close();
        }
    }

    public close(): void {
        if (this.overlay?.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
        this.overlay = null;
        this.revokeObjectUrls();
        if (this.escHandler) document.removeEventListener('keydown', this.escHandler);
        this.escHandler = null;
    }

    private async refreshAssetList(): Promise<void> {
        if (!this.listContainer) return;

        this.revokeObjectUrls();
        this.listContainer.innerHTML = '<div class="mdx-empty-state">加载中...</div>';

        let files: FSNode[] = [];
        try {
            // includeAssetDirs: true — asset filenames may start with '_' (reserved prefix);
            // without this flag they would be silently filtered out by getChildren.
            files = await this.engine.driver.getChildren(this.currentAssetDirPath, { includeAssetDirs: true });
        } catch (e) {
            console.error('[AssetManager] Failed to get children:', e);
            this.listContainer.innerHTML = '<div class="mdx-empty-state">读取目录失败</div>';
            return;
        }

        const assetFiles = files.filter(f => {
            if (f.type !== 'file') return false;
            return isAssetVisible(f.name, this.options.viewFilter);
        });

        if (assetFiles.length === 0) {
            this.listContainer.innerHTML = '<div class="mdx-empty-state">暂无附件</div>';
            this.updateToolbar(0, 0, () => { });
            return;
        }

        // 扫描引用
        const content = this.editor?.getText() ?? '';
        const usedAssets = this.extractReferencedFilenames(content);

        const displayItems: AssetDisplayItem[] = assetFiles.map(node => ({
            node,
            isUsed: usedAssets.has(node.name)
        }));

        // 生成预览
        await this.loadPreviews(displayItems);

        this.renderList(displayItems);

        const unusedCount = displayItems.filter(i => !i.isUsed).length;
        this.updateToolbar(displayItems.length, unusedCount, () => {
            this.handleBatchDelete(displayItems.filter(i => !i.isUsed));
        });
    }

    /**
     * 从内容中提取所有引用的文件名
     * 改进版：更精确的正则匹配
     */
    private extractReferencedFilenames(content: string): Set<string> {
        const filenames = new Set<string>();

        // 1. 匹配裸 @asset/path/filename（Markdown 链接由下一步完整解析）
        const assetRegex = /(?<!<)@asset\/([^\s)"'>]+)/g;
        let match;
        while ((match = assetRegex.exec(content)) !== null) {
            this.addReferencedPath(`@asset/${match[1]}`, filenames);
        }

        // 2. 匹配 Markdown 链接语法 [text](path)
        // 支持普通 destination 以及含空格的 <destination>。
        const linkRegex = /\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)/g;
        while ((match = linkRegex.exec(content)) !== null) {
            this.addReferencedPath(match[1] || match[2], filenames);
        }

        // 3. 匹配 HTML src/href 属性
        const htmlAttrRegex = /(?:src|href)=["']([^"']+)["']/g;
        while ((match = htmlAttrRegex.exec(content)) !== null) {
            this.addReferencedPath(match[1], filenames);
        }

        return filenames;
    }

    private addReferencedPath(path: string, filenames: Set<string>): void {
        if (this.shouldSkipPath(path)) return;
        const filename = extractFilenameFromPath(path);
        if (filename && !filename.startsWith('#')) filenames.add(filename);
    }

    /**
     * 判断路径是否应该跳过（不作为资源引用处理）
     */
    private shouldSkipPath(path: string): boolean {
        return (
            path.startsWith('http://') ||
            path.startsWith('https://') ||
            path.startsWith('data:') ||
            path.startsWith('mailto:') ||
            path.startsWith('tel:') ||
            path.startsWith('javascript:') ||
            path.startsWith('#')
        );
    }

    private async loadPreviews(items: AssetDisplayItem[]): Promise<void> {
        const previewPromises = items.map(async (item) => {
            if (!this.isPreviewableImage(item.node.name)) return;

            try {
                const buffer = await this.engine.driver.readContent(item.node.path);
                if (!buffer) return;

                const mimeType = guessMimeType(item.node.name);
                const blob = new Blob([buffer as ArrayBuffer], { type: mimeType });
                const url = URL.createObjectURL(blob);
                this.objectUrls.push(url);
                item.url = url;
            } catch (e) {
                console.warn('[AssetManager] Preview load failed:', item.node.name);
            }
        });

        await Promise.all(previewPromises);
    }

    private updateToolbar(total: number, unused: number, onClean: () => void): void {
        if (!this.statsEl || !this.cleanBtn) return;

        this.statsEl.textContent = `共 ${total} 个附件，${unused} 个未引用`;

        if (unused > 0) {
            this.cleanBtn.style.display = 'inline-block';
            this.cleanBtn.textContent = `清理 ${unused} 个未引用`;
            this.cleanBtn.onclick = onClean;
        } else {
            this.cleanBtn.style.display = 'none';
        }
    }

    private renderList(items: AssetDisplayItem[]): void {
        if (!this.listContainer) return;
        this.listContainer.innerHTML = '';

        // 排序: 未引用优先，然后按时间倒序
        items.sort((a, b) => {
            if (a.isUsed !== b.isUsed) return a.isUsed ? 1 : -1;
            return b.node.createdAt - a.node.createdAt;
        });

        const fragment = document.createDocumentFragment();

        items.forEach(item => {
            const li = this.createAssetItem(item);
            fragment.appendChild(li);
        });

        this.listContainer.appendChild(fragment);
    }

    private createAssetItem(item: AssetDisplayItem): HTMLLIElement {
        const li = document.createElement('li');
        li.className = 'mdx-asset-item';

        // 缩略图
        const thumb = document.createElement('img');
        thumb.className = 'mdx-asset-thumb';
        thumb.src = item.url || this.getFileIcon(item.node.name);
        thumb.alt = item.node.name;

        // 操作按钮
        const actions = this.createActionButtons(item);

        li.append(thumb, this.createAssetInfo(item), actions);
        return li;
    }

    private createAssetInfo(item: AssetDisplayItem): HTMLDivElement {
        const info = document.createElement('div');
        info.className = 'mdx-asset-info';

        const name = document.createElement('div');
        name.className = 'mdx-asset-name';
        name.title = item.node.name;
        name.textContent = item.node.name;

        const meta = document.createElement('div');
        meta.className = 'mdx-asset-meta';
        const badge = document.createElement('span');
        badge.className = `mdx-asset-badge ${item.isUsed ? 'used' : 'unused'}`;
        badge.textContent = item.isUsed ? '已引用' : '未引用';
        const size = this.formatFileSize((item.node as FSFileNode).size || 0);
        const date = new Date(item.node.createdAt).toLocaleDateString();
        meta.append(badge, this.createTextSpan(size), this.createTextSpan(date));
        info.append(name, meta);
        return info;
    }

    private createTextSpan(text: string): HTMLSpanElement {
        const span = document.createElement('span');
        span.textContent = text;
        return span;
    }

    private createActionButtons(item: AssetDisplayItem): HTMLDivElement {
        const actions = document.createElement('div');
        actions.className = 'mdx-asset-actions';

        // 插入按钮
        const insertBtn = this.createButton('插入', 'primary', () => {
            const path = generateAssetPath(item.node.name);
            const destination = /[\s()]/.test(path) ? `<${path}>` : path;
            const label = item.node.name.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');
            const text = this.isPreviewableImage(item.node.name)
                ? `![${label}](${destination})`
                : `[${label}](${destination})`;
            this.insertText(text);
            this.close();
        });

        // 下载按钮
        const downloadBtn = this.createButton('下载', 'default', () => {
            this.handleDownload(item.node);
        });

        // 删除按钮
        const deleteBtn = this.createButton('删除', 'danger', async () => {
            if (item.isUsed) {
                // Tauri v2 replaces window.confirm() with a Promise-based dialog.
                let confirmed: boolean | Promise<boolean> = confirm(
                    `文件 "${item.node.name}" 正在被引用，删除将导致文档内容缺失。\n\n确定要删除吗？`
                );
                confirmed = await Promise.resolve(confirmed);
                if (!confirmed) return;
            }

            try {
                await this.engine.driver.delete([item.node.path]);
                Toast.success('删除成功');
                await this.refreshAssetList();
            } catch (e) {
                console.error('[AssetManager] Delete failed:', e);
                Toast.error('删除失败');
            }
        });

        actions.append(insertBtn, downloadBtn, deleteBtn);
        return actions;
    }

    private createButton(
        text: string,
        type: 'primary' | 'default' | 'danger',
        onClick: () => void
    ): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `mdx-btn mdx-btn--${type}`;
        btn.textContent = text;
        btn.onclick = onClick;
        return btn;
    }

    private async handleDownload(node: FSNode): Promise<void> {
        try {
            const content = await this.engine.driver.readContent(node.path);
            if (!content) {
                Toast.error('文件内容为空');
                return;
            }

            const mimeType = guessMimeType(node.name);
            const blob = new Blob([content as ArrayBuffer], { type: mimeType });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = node.name;
            document.body.appendChild(a);
            a.click();

            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            Toast.success('下载已开始');
        } catch (e) {
            console.error('[AssetManager] Download failed:', e);
            Toast.error('下载失败');
        }
    }

    private async handleBatchDelete(items: AssetDisplayItem[]): Promise<void> {
        if (items.length === 0) return;

        // Tauri v2 replaces window.confirm() with a Promise-based dialog.
        let confirmed: boolean | Promise<boolean> = confirm(`确定要永久删除这 ${items.length} 个未引用的文件吗？`);
        confirmed = await Promise.resolve(confirmed);
        if (!confirmed) return;

        try {
            await this.engine.driver.delete(items.map(i => i.node.path));
            Toast.success(`已清理 ${items.length} 个文件`);
            await this.refreshAssetList();
        } catch (e) {
            console.error('[AssetManager] Batch delete failed:', e);
            Toast.error('批量删除失败');
        }
    }

    private insertText(text: string): void {
        if (!this.editor) {
            Toast.info('当前视图不支持插入附件链接');
            return;
        }
        const view = this.editor.getEditorView();
        if (!view) return;

        const range = view.state.selection.main;
        view.dispatch({
            changes: { from: range.from, to: range.to, insert: text }
        });
        this.editor.focus();
        Toast.success('已插入链接');
    }

    private createModalStructure(): void {
        const overlay = document.createElement('div');
        overlay.className = 'mdx-asset-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'mdx-asset-modal';

        modal.innerHTML = `
            <div class="mdx-asset-header">
                <h3>附件管理</h3>
                <button type="button" class="mdx-asset-close" aria-label="关闭">&times;</button>
            </div>
            <div class="mdx-asset-toolbar">
                <span class="mdx-stats"></span>
                <button type="button" class="mdx-btn mdx-btn--danger mdx-clean-btn" style="display:none"></button>
            </div>
            <ul class="mdx-asset-list"></ul>
        `;

        overlay.appendChild(modal);

        this.overlay = overlay;
        this.listContainer = modal.querySelector('.mdx-asset-list')!;
        this.statsEl = modal.querySelector('.mdx-stats')!;
        this.cleanBtn = modal.querySelector('.mdx-clean-btn')!;

        const closeBtn = modal.querySelector('.mdx-asset-close')!;
        closeBtn.addEventListener('click', () => this.close());

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) this.close();
        });

        // ESC 关闭
        this.escHandler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                this.close();
            }
        };
        document.addEventListener('keydown', this.escHandler);
    }

    private revokeObjectUrls(): void {
        this.objectUrls.forEach(url => URL.revokeObjectURL(url));
        this.objectUrls = [];
    }

    private isPreviewableImage(name: string): boolean {
        return /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i.test(name);
    }

    private getFileIcon(filename: string): string {
        const ext = filename.split('.').pop()?.toLowerCase() || '';

        // 根据文件类型返回不同的图标
        const iconMap: Record<string, string> = {
            'pdf': this.createSvgIcon('📄', '#e74c3c'),
            'doc': this.createSvgIcon('📝', '#2980b9'),
            'docx': this.createSvgIcon('📝', '#2980b9'),
            'xls': this.createSvgIcon('📊', '#27ae60'),
            'xlsx': this.createSvgIcon('📊', '#27ae60'),
            'ppt': this.createSvgIcon('📽️', '#e67e22'),
            'pptx': this.createSvgIcon('📽️', '#e67e22'),
            'zip': this.createSvgIcon('📦', '#9b59b6'),
            'rar': this.createSvgIcon('📦', '#9b59b6'),
            'mp4': this.createSvgIcon('🎬', '#1abc9c'),
            'webm': this.createSvgIcon('🎬', '#1abc9c'),
            'mp3': this.createSvgIcon('🎵', '#e91e63'),
            'wav': this.createSvgIcon('🎵', '#e91e63'),
        };

        return iconMap[ext] || this.createSvgIcon('📎', '#95a5a6');
    }

    private createSvgIcon(emoji: string, _color: string): string {
        // 使用 Data URL 返回简单的文本图标
        const svg = `
            <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
                <rect width="48" height="48" fill="#f5f5f5" rx="4"/>
                <text x="24" y="32" font-size="24" text-anchor="middle">${emoji}</text>
            </svg>
        `;
        return `data:image/svg+xml;base64,${btoa(svg)}`;
    }

    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 B';

        const units = ['B', 'KB', 'MB', 'GB'];
        const k = 1024;
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        const size = bytes / Math.pow(k, i);

        return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
    }
}
