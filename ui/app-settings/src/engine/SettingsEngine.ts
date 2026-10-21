/**
 * @file app-settings/engine/SettingsEngine.ts
 * @desc Custom IFileSystem implementation — maps settings pages to virtual file nodes.
 *       Read-only flat list; write operations throw "not supported".
 *
 * v3.3: Refactored from IFSEngine → IFileSystem.
 *       Settings pages appear as file-type FSNode entries in a flat directory.
 */
import type {
    IFileSystem,
    IFSDriver,
    IFSMetaDriver,
    FSNode,
    FSFileNode,
    FSSearchResult,
    FSCapabilities,
    FileSystemStats,
    FileContent,
    ReadOptions,
    ListOptions,
    FSSearchQuery,
    FSEventType,
    FSEvent,
    IAssetOperations,
    ITagOperations,
} from '@itookit/vfs-core';
import { FSCapabilityError } from '@itookit/vfs-core';

// UI 定义：ID -> 元数据
export const SETTINGS_PAGES: Record<string, { name: string, icon: string }> = {
    'appearance':  { name: '外观',           icon: '🎨' },
    'storage':     { name: '文件系统',     icon: '💾' },
    'tags':        { name: 'Tags',          icon: '🏷️' },
    'contacts':    { name: 'Contacts',      icon: '📒' },
    'providers':   { name: 'LLM Providers', icon: '🏭' },
    'connections': { name: 'LLM 连接',      icon: '🔗' },
    'mcp-servers': { name: 'MCP Servers',   icon: '🔌' },
    'cost':        { name: '费用统计',      icon: '💰' },
    'system-prompts': { name: 'System Prompts', icon: '📝' },
    'recovery':    { name: '系统恢复',      icon: '🚑' },
    'log':         { name: '系统日志',      icon: '📋' },
    'about':       { name: 'About',         icon: 'ℹ️' },
    'fs-explorer': { name: 'FS Explorer',   icon: '🗂️' },
};

function toFSNode(id: string, config: (typeof SETTINGS_PAGES)[string]): FSFileNode {
    const now = Date.now();
    return {
        parentPath: null,
        name: config.name,
        type: 'file',
        icon: config.icon,
        path: id,
        size: 0,
        createdAt: now,
        modifiedAt: now,
        version: 0,
        viewId: 'settings_ui',
        tags: [],
        metadata: { title: config.name, description: '' },
    };
}

// ── 空能力 ─────────────────────────────────────────────────────

const READONLY_CAPS: FSCapabilities = Object.freeze({
    readonly: true, search: true, semanticSearch: false, syncable: false,
    assets: false, tags: false, deviceFiles: false,
    seqFiles: false, references: false, symlinks: false, hardlinks: false,
    partialRead: false, partialWrite: false, treeWalk: false,
    streaming: false, watch: false, mount: false,
});

// ── Tags no-op ──────────────────────────────────────────────────

const noopTags: ITagOperations = {
    getAllTags: async () => [],
    setTags: async () => {},
    addTag: async () => {},
    removeTag: async () => {},
    walkByTag: async () => ({ total: 0, processed: 0 }),
};

// ── Assets no-op ───────────────────────────────────────────────

const noopAssets: IAssetOperations = {
    putAsset: async () => ({ type: 'file' } as FSFileNode),
    getAsset: async () => null,
    getAssetDirPath: async () => null,
    ensureAssetDir: async () => { throw new FSCapabilityError('assets', 'settings_root'); },
    listAssets: async () => [],
    deleteAsset: async () => {},
    removeAssetDir: async () => {},
    hasAssetDir: async () => false,
};

// ═══════════════════════════════════════════════════════════════
// SettingsEngine
// ═══════════════════════════════════════════════════════════════

export class SettingsEngine implements IFileSystem {
    readonly revision = 0;
    async capabilitiesAt(_path: string) { return this.capabilities; }
    readonly viewId = 'settings_root';
    readonly capabilities: FSCapabilities = READONLY_CAPS;
    readonly driver: IFSDriver;
    readonly meta: IFSMetaDriver = {
        assets: noopAssets,
        tags: noopTags,
    };

    readonly pages: typeof SETTINGS_PAGES;
    constructor(excludedPages: readonly string[] = []) {
        this.pages = Object.fromEntries(Object.entries(SETTINGS_PAGES).filter(([id]) => !excludedPages.includes(id)));
        this.driver = new SettingsDriver(this);
    }

    async init(): Promise<void> {}
    async dispose(): Promise<void> {}

    openFile(_nodeId: string): never {
        throw new Error('SettingsEngine: openFile not supported — settings are not real files');
    }

    on<E extends FSEventType>(event: E, callback: (event: FSEvent<E>) => void): () => void {
        return this.driver.on(event, callback);
    }

    onAny(callback: (event: FSEvent) => void): () => void {
        return this.driver.onAny?.(callback) ?? (() => {});
    }
}

// ═══════════════════════════════════════════════════════════════
// SettingsDriver — 内联 IFSDriver
// ═══════════════════════════════════════════════════════════════

class SettingsDriver implements IFSDriver {
    readonly viewId = 'settings_root';
    readonly capabilities: FSCapabilities = READONLY_CAPS;

    constructor(private readonly engine: SettingsEngine) {}

    // ── Events ───────────────────────────────────────
    on<E extends FSEventType>(_event: E, _callback: (event: FSEvent<E>) => void): () => void {
        return () => {};
    }

    // ── Read ─────────────────────────────────────────
    async getNode(id: string): Promise<FSNode | null> {
        const config = this.engine.pages[id];
        return config ? toFSNode(id, config) : null;
    }

    async getChildren(parentId: string, _options?: ListOptions): Promise<FSNode[]> {
        if (parentId !== '/') return [];
        return Object.entries(this.engine.pages).map(([id, c]) => toFSNode(id, c));
    }

    readContent(id: string, options: ReadOptions & { encoding: 'utf-8' }): Promise<string>;
    readContent(id: string, options: ReadOptions & { encoding: 'binary' }): Promise<ArrayBuffer>;
    readContent(id: string, options?: ReadOptions): Promise<FileContent>;
    async readContent(id: string, _options?: ReadOptions): Promise<FileContent> {
        return id;
    }

    async resolvePath(_path: string): Promise<string | null> {
        // path === slug after toFSNode change
        if (_path in this.engine.pages) return _path;
        // backward-compat: accept legacy "/${name}" paths
        for (const [id, cfg] of Object.entries(this.engine.pages)) {
            if (_path === `/${cfg.name}`) return id;
        }
        return null;
    }

    async exists(id: string): Promise<boolean> {
        return id in this.engine.pages;
    }

    async search(query: FSSearchQuery): Promise<FSSearchResult> {
        const text = query.name?.contains;
        const nodes: FSNode[] = [];
        if (text) {
            const lower = text.toLowerCase();
            for (const [id, cfg] of Object.entries(this.engine.pages)) {
                if (cfg.name.toLowerCase().includes(lower)) {
                    nodes.push(toFSNode(id, cfg));
                }
            }
        }
        return { nodes: nodes, total: nodes.length, hasMore: false };
    }

    async getStats(): Promise<FileSystemStats> {
        const count = Object.keys(this.engine.pages).length;
        return { fileCount: count, directoryCount: 1, totalSize: 0, lastModifiedAt: Date.now() };
    }

    // ── Write (no-op or throw) ────────────────────────
    async writeContent(): Promise<void> {
        console.warn('Direct write to SettingsEngine ignored. Use SettingsService.');
    }
    async updateMetadata(): Promise<void> { /* no-op */ }
    async appendContent(): Promise<void> { throw new Error('not supported'); }

    async createFile(): Promise<FSNode> {
        throw new Error('Cannot create new settings pages.');
    }
    async createDirectory(): Promise<FSNode> {
        throw new Error('Cannot create directories in settings.');
    }
    async rename(): Promise<void> {
        throw new Error('Cannot rename settings.');
    }
    async move(): Promise<void> {
        throw new Error('Cannot move settings.');
    }
    async delete(): Promise<void> {
        throw new Error('Cannot delete settings.');
    }

    // ── Links (unsupported) ───────────────────────────
    async symlink(): Promise<FSNode> { throw new FSCapabilityError('symlinks', this.viewId); }
    async readlink(): Promise<string> { throw new FSCapabilityError('symlinks', this.viewId); }
    async hardlink(): Promise<FSNode> { throw new FSCapabilityError('hardlinks', this.viewId); }

    // ── Transaction (unsupported) ────────────────────
    async transaction<T>(): Promise<T> {
        throw new FSCapabilityError('transaction', this.viewId);
    }
}
