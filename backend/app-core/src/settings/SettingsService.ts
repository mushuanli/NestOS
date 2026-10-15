import { SettingsFiles, writeWorkspaceFile } from './workspace-files';
import { exportFileSystem, importFileSystem } from '@itookit/vfs-core';
/**
 * @file: app-settings/services/SettingsService.ts
 */
import type { IVFSManager, IFileSystem } from '@itookit/vfs-core';
import { FSNotFoundError } from '@itookit/vfs-core';
import { LabelStore, TAG_STORE_PATH } from './LabelStore';
import { traceBoot } from '@itookit/common';
import { SettingsState, Contact, Tag } from '@itookit/app-contracts/settings';
import type { SnapshotPort, SettingsPort, SettingsWorkspaceSource, WorkspaceDescription } from '@itookit/app-contracts/settings';
import { FSError } from '@itookit/vfs-core';

// UI display: modules not shown to users in workspace picker


const FILES = {
    tags: TAG_STORE_PATH,
    contacts: '/contacts.json',
};

// ============================================
// 类型定义
// ============================================

// Re-export so existing callers don't need to change imports
export type { LocalSnapshot } from '@itookit/app-contracts/settings';

type ChangeListener = () => void;

// ============================================
// SettingsService
// ============================================

/**
 * SettingsService
 * 职责：
 * 1. 管理通用应用设置（Tags, Contacts）
 * 2. 提供系统级维护功能（快照、备份、重置）
 * 3. 协调 VFS 配置模块的挂载
 */
export class SettingsService implements SettingsPort {
    configFiles!: IFileSystem;
    public readonly vfs: IVFSManager;

    private state: Pick<SettingsState, 'tags' | 'contacts'> = {
        tags: [],
        contacts: [],
    };

    private listeners: Set<ChangeListener> = new Set();
    private initialized = false;
    private tagRefresh?: Promise<void>;
    private tagStore!: LabelStore;

    public readonly snapshot: SnapshotPort;
    readonly workspaces: readonly WorkspaceDescription[];
    private readonly files: SettingsFiles;

    constructor(vfs: IVFSManager, _dbName: string = 'MindOS-v2', sources: readonly SettingsWorkspaceSource[] = [], snapshot?: SnapshotPort) {
        this.vfs = vfs;
        this.files = new SettingsFiles(vfs, sources); this.workspaces = this.files.descriptions();
        this.snapshot = snapshot ?? unavailableSnapshots;
    }

    // =========================================================
    // 初始化
    // =========================================================

    private initialization?: Promise<void>;
    init(): Promise<void> { return this.initialization ??= this.initialize(); }
    private async initialize(): Promise<void> {
        if (this.initialized) return;

        this.configFiles = await this.vfs.openFileSystem('/etc');
        this.tagStore = new LabelStore(this.configFiles);

        // 1. 加载数据
        await Promise.all([
            traceBoot('settings.contacts', () => this.loadEntity('contacts')),
            traceBoot('settings.tagDefinitions', async () => { this.state.tags = await this.tagStore.list(); }),
        ]);

        this.initialized = true;
        this.notify();
    }

    /**
     * 检查是否为"未找到"错误
     */
    private isNotFoundError(e: any): boolean {
        return (
            e instanceof FSNotFoundError ||
            e?.code === 'ENOENT' ||
            e?.code === 'NOT_FOUND' ||
            String(e?.message).toLowerCase().includes('not found')
        );
    }

    // =========================================================
    // 通用实体存取 (Tags / Contacts)
    // =========================================================

    private async loadEntity<K extends keyof Pick<SettingsState, 'tags' | 'contacts'>>(key: K): Promise<void> {
        const path = FILES[key];
        try {
            const content = await this.configFiles.driver.readContent(path);
            const jsonStr = typeof content === 'string' 
                ? content 
                : new TextDecoder().decode(content as ArrayBuffer);
            this.state[key] = JSON.parse(jsonStr);
        } catch (e: any) {
            if (this.isNotFoundError(e)) {
                this.state[key] = [];
            } else {
                console.error(`Failed to load ${key}`, e);
            }
        }
    }

    private async saveEntity<K extends keyof Pick<SettingsState, 'tags' | 'contacts'>>(key: K): Promise<void> {
        const path = FILES[key];
        const content = JSON.stringify(this.state[key], null, 2);
        await writeWorkspaceFile(this.configFiles, path, content);
        if (key !== 'tags') this.notify();
    }

    // =========================================================
    // CRUD: Contacts
    // =========================================================

    async readPreference(path: string): Promise<string> {
        await this.init();
        return this.configFiles.driver.readContent(path, { encoding: 'utf-8' });
    }
    async writePreference(path: string, content: string): Promise<void> {
        await this.init();
        await writeWorkspaceFile(this.configFiles, path, content);
    }

    getContacts(): Contact[] {
        return [...this.state.contacts];
    }

    async saveContact(contact: Contact): Promise<void> {
        await this.init();
        this.updateOrAdd(this.state.contacts, contact);
        await this.saveEntity('contacts');
    }

    async deleteContact(id: string): Promise<void> {
        await this.init();
        this.state.contacts = this.state.contacts.filter((c) => c.id !== id);
        await this.saveEntity('contacts');
        this.notify();
    }

    // =========================================================
    // CRUD: Tags
    // =========================================================

    getTags(): Tag[] {
        return [...this.state.tags];
    }

    public syncTags(): Promise<void> {
        // Opening/focusing the tag editor requests fresh counts. Startup and
        // ordinary file changes must not launch a workspace traversal.
        return this.tagRefresh ??= this.refreshTags().finally(() => { this.tagRefresh = undefined; });
    }

    openWorkspace(name: string): Promise<IFileSystem> { return this.files.open(name); }

    private async refreshTags(): Promise<void> {
        try {
            const configTags = await this.tagStore.list();

            const counts = new Map<string, { name: string; color?: string; refCount: number }>();
            for (const source of await this.files.tags()) {
                const tags = await traceBoot(`settings.tags[${source.name}].getAllTags`, () => source.fs.meta.tags.getAllTags());
                console.log(`[Boot] settings.tags[${source.name}]: ${tags.length} tags`);
                for (const tag of tags) {
                    const count = tag.refCount ?? 0;
                    const previous = counts.get(tag.name);
                    counts.set(tag.name, { name: tag.name, color: tag.color ?? previous?.color,
                        refCount: (previous?.refCount ?? 0) + count });
                }
            }
            const vfsTags = [...counts.values()];

            const merged = new Map(configTags.map(tag => [tag.name, { ...tag, count: 0 }]));
            for (const tag of vfsTags) {
                const definition = merged.get(tag.name);
                merged.set(tag.name, {
                    id: definition?.id ?? tag.name, name: tag.name,
                    color: definition?.color ?? tag.color ?? '#3b82f6',
                    description: definition?.description ?? '', count: tag.refCount,
                });
            }
            const mergedTags: Tag[] = [...merged.values()];

            const oldStateStr = JSON.stringify(this.state.tags);
            this.state.tags = mergedTags;
            const newStateStr = JSON.stringify(this.state.tags);

            if (oldStateStr !== newStateStr) {
                if (this.initialized) this.notify();
            }
        } catch (e) {
            console.error('[SettingsService] Failed to query tag indexes:', e);
            throw e;
        }
    }

    async saveTag(tag: Tag): Promise<void> {
        await this.init();
        // 更新 VFS 的标签定义
        await this.tagStore.save(tag);
        this.updateOrAdd(this.state.tags, tag);
        this.notify();
    }

    async deleteTag(tagId: string): Promise<void> {
        await this.init();
        const tag = this.state.tags.find((t) => t.id === tagId);
        if (!tag) return;

        // 注意：VFS 可能没有直接的 deleteTagDefinition
        // 需要通过 TagManager 或者从所有节点移除该标签
        try {
            for (const source of await this.files.tags()) {
                const paths: string[] = [];
                await source.fs.meta.tags.walkByTag(tag.name, path => { paths.push(path); return true; });
                for (const path of paths) await source.fs.meta.tags.removeTag(path, tag.name);
            }
        } catch (e) {
            console.error('Failed to remove tag associations', e);
            throw e;
        }

        await this.tagStore.delete(tagId);
        this.state.tags = this.state.tags.filter((t) => t.id !== tagId);
        this.notify();
    }

    // =========================================================
    // Export/Import Logic
    // =========================================================

    async exportMixedData(
        settingsKeys: (keyof SettingsState)[], 
        moduleNames: string[]
    ): Promise<any> {
        await this.init();
        const exportData: any = {
            version: 3,
            timestamp: Date.now(),
            type: 'mixed_backup',
            settings: {},
            workspaces: [],
        };

        if (settingsKeys.includes('tags')) {
            exportData.settings.tags = this.state.tags;
        }
        if (settingsKeys.includes('contacts')) {
            exportData.settings.contacts = this.state.contacts;
        }

        for (const name of moduleNames) {
            exportData.workspaces.push({ name, archive: await exportFileSystem(await this.openWorkspace(name)) });
        }
        return exportData;
    }

    async importMixedData(
        data: any,
        settingsKeys: (keyof SettingsState)[],
        workspaceNames: string[],
        _options: { overwrite?: boolean; mergeTags?: boolean } = {}
    ): Promise<void> {
        await this.init();
        if (data?.version !== 3 || data.type !== 'mixed_backup' || !Array.isArray(data.workspaces)) throw new Error('Unsupported backup; convert it before importing');
        const selected = data.workspaces.filter((entry: any) => workspaceNames.includes(entry.name));
        const seen = new Set<string>();
        for (const entry of selected) {
            if (seen.has(entry.name)) throw new Error(`Duplicate backup workspace: ${entry.name}`);
            seen.add(entry.name);
            await this.openWorkspace(entry.name);
        }
        for (const name of workspaceNames) if (!seen.has(name)) throw new Error(`Backup workspace missing: ${name}`);
        // Cross-source restore is not atomic. Propagate failures so the UI never
        // reports success for a partial restore. Settings are saved afterwards.
        for (const entry of selected) await importFileSystem(await this.openWorkspace(entry.name), entry.archive);
        if (settingsKeys.includes('tags') && Array.isArray(data.settings?.tags)) {
            this.state.tags = data.settings.tags;
            await this.tagStore.replaceAll(data.settings.tags);
        }
        if (settingsKeys.includes('contacts') && Array.isArray(data.settings?.contacts)) {
            this.state.contacts = data.settings.contacts;
            await this.saveEntity('contacts');
        }
        await this.syncTags();
        this.notify();
    }

    // =========================================================
    // 本地快照管理 — 委托给 SnapshotService
    // =========================================================

    listLocalSnapshots() { return this.snapshot.listLocalSnapshots(); }
    async estimateStorage() { return this.snapshot.estimate?.() ?? null; }
    createSnapshot()     { return this.snapshot.createSnapshot(); }
    deleteSnapshot(name: string) { return this.snapshot.deleteSnapshot(name); }

    async restoreSnapshot(snapshotName: string): Promise<void> {
        await this.init();
        await this.snapshot.restoreSnapshot(snapshotName);
        // 恢复后需要重新初始化 VFS
    }

    // =========================================================
    // 系统级操作
    // =========================================================

    async factoryReset(): Promise<void> {
        await this.snapshot.factoryReset();

        // 重置状态
        this.state = { tags: [], contacts: [] };
        this.initialized = false;
    }

    // =========================================================
    // 辅助方法 & 事件
    // =========================================================

    private updateOrAdd<T extends { id: string }>(list: T[], item: T): void {
        const idx = list.findIndex((i) => i.id === item.id);
        if (idx >= 0) {
            list[idx] = item;
        } else {
            list.push(item);
        }
        this.notify();
    }

    onChange(listener: ChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private notify(): void {
        this.listeners.forEach((l) => {
            try {
                l();
            } catch (e) {
                console.error('[SettingsService] Listener error:', e);
            }
        });
    }

    getAvailableSettingsKeys(): (keyof SettingsState)[] {
        return ['tags', 'contacts'];
    }

    getAvailableWorkspaces(): Array<{ name: string; description?: string }> {
        return this.workspaces.map(source => ({ name: source.name, description: source.description }));
    }

    /**
     * 清理资源
     */
    async dispose(): Promise<void> {
        await this.initialization?.catch(() => {});
        // 清理监听器
        this.listeners.clear();

        this.initialized = false;
    }
}

const unavailable = async (): Promise<never> => { throw new FSError('ECAPABILITY', 'Storage snapshots are unavailable in this host'); };
const unavailableSnapshots: SnapshotPort = { listLocalSnapshots: async () => [], createSnapshot: unavailable, restoreSnapshot: unavailable, deleteSnapshot: unavailable, factoryReset: unavailable };
