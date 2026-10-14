// @mdx/core/store/engine-metadata-store.ts
import type { IFileSystem } from '@itookit/vfs-core';
import type { ScopedPersistenceStore } from '@itookit/mdxeditor';

type PluginDataRecord = Record<string, unknown>;

function isPluginData(value: unknown): value is PluginDataRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 基于 IFileSystem 元数据的持久化存储
 * 特性：防抖批量写入、并发安全、销毁保护
 *
 * v3.3: 依赖 IFileSystem（不再依赖 IFSEngine）
 */
export class EngineMetadataStore implements ScopedPersistenceStore {
    private pendingUpdates = new Map<string, unknown>();
    private flushTimer: number | null = null;
    private flushPromise: Promise<void> | null = null;
    private isDestroyed = false;

    constructor(
        private engine: IFileSystem,
        private nodeId: string,
        private pluginNamespace: string
    ) { }

    private getMetaKey(): string {
        return `_mdx_plugin_${this.pluginNamespace}`;
    }

    updateDocumentPath(newNodeId: string): void {
        this.nodeId = newNodeId;
    }

    async get(key: string): Promise<unknown> {
        if (this.isDestroyed) return undefined;

        if (this.pendingUpdates.has(key)) {
            return this.pendingUpdates.get(key);
        }

        try {
            const node = await this.engine.driver.getNode(this.nodeId);
            if (!node) return undefined;
            const pluginData = node.metadata?.[this.getMetaKey()];
            return isPluginData(pluginData) ? pluginData[key] : undefined;
        } catch (error) {
            console.warn(`[EngineMetadataStore] Get "${key}" failed:`, error);
            return undefined;
        }
    }

    async set(key: string, value: unknown): Promise<void> {
        if (this.isDestroyed) return;
        this.pendingUpdates.set(key, value);
        this.scheduleFlush();
    }

    async remove(key: string): Promise<void> {
        if (this.isDestroyed) return;
        this.pendingUpdates.set(key, undefined);
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.isDestroyed || this.flushTimer) return;
        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, 100);
    }

    private async flush(): Promise<void> {
        if (this.isDestroyed || this.pendingUpdates.size === 0) return;
        if (this.flushPromise) {
            await this.flushPromise;
            return;
        }

        this.flushPromise = (async () => {
            try {
                const node = await this.engine.driver.getNode(this.nodeId);
                if (!node) throw new Error(`Node ${this.nodeId} not found`);

                const metaKey = this.getMetaKey();
                const storedData = node.metadata?.[metaKey];
                const pluginData: PluginDataRecord = isPluginData(storedData)
                    ? { ...storedData }
                    : {};

                for (const [k, v] of this.pendingUpdates) {
                    if (v === undefined) delete pluginData[k];
                    else pluginData[k] = v;
                }

                await this.engine.driver.updateMetadata(this.nodeId, {
                    ...node.metadata,
                    [metaKey]: pluginData,
                });
                this.pendingUpdates.clear();
            } catch (error) {
                console.error('[EngineMetadataStore] Flush failed:', error);
            } finally {
                this.flushPromise = null;
            }
        })();

        await this.flushPromise;
    }

    destroy(): void {
        this.isDestroyed = true;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.pendingUpdates.clear();
        this.flushPromise = null;
    }
}
