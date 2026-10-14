import { createSessionHost, type SessionLogger } from './host-ports';
import type { IFileSystem } from '@itookit/vfs-core';
export type ChangeListener = () => void;

/** Business persistence helpers over an injected file capability; no host ownership. */
export abstract class FileBackedService {
    /** v3.3: IFileSystem — 子类通过 engine.driver.* 进行文件操作 */
    public readonly engine: IFileSystem;
    protected initialized = false;
    protected listeners = new Set<ChangeListener>();

    constructor(fs: IFileSystem, protected readonly serviceLogger: SessionLogger = createSessionHost().logger) { this.engine = fs; }

    // ── 生命周期 ──────────────────────────────────────────────

    private loading?: Promise<void>;
    private closed = false;
    init(): Promise<void> {
        if (this.closed) return Promise.reject(new Error('Service is disposed'));
        if (this.initialized) return Promise.resolve();
        if (!this.loading) {
            const work = this.onLoad().then(() => { this.initialized = true; this.notify(); });
            this.loading = work;
            void work.finally(() => { if (this.loading === work) this.loading = undefined; }).catch(() => {});
        }
        return this.loading;
    }
    protected async waitForLoad(): Promise<void> { await this.loading; }

    protected abstract onLoad(): Promise<void>;

    get isInitialized(): boolean {
        return this.initialized;
    }

    async dispose(): Promise<void> {
        this.closed = true;
        await this.loading?.catch(() => {});
        this.listeners.clear();
        this.initialized = false;
    }

    // ── JSON 辅助方法 ─────────────────────────────────────────

    /**
     * 读取 JSON 文件
     * @returns 解析后的对象，文件不存在返回 null
     */
    protected async readJson<T>(path: string): Promise<T | null> {
        try {
            const content = await this.engine.driver.readContent(path, { representation: 'bytes' });
            const str =
                typeof content === 'string'
                    ? content
                    : new TextDecoder().decode(content as ArrayBuffer);
            return JSON.parse(str) as T;
        } catch (e: unknown) {
            const message = getErrorMessage(e).toLowerCase();
            const code = getErrorCode(e);
            const isNotFound =
                message.includes('not found') ||
                code === 'ENOENT' ||
                code === 'NOT_FOUND';
            if (!isNotFound) {
                this.serviceLogger.warn('Failed to read persisted entity', { path, error: e });
            }
            return null;
        }
    }

    /**
     * 写入 JSON 文件（upsert 语义：不存在则创建，含中间目录）
     */
    protected async writeJson(path: string, data: unknown): Promise<void> {
        const content = JSON.stringify(data, null, 2);
        if (await this.engine.driver.exists(path)) await this.engine.driver.writeContent(path, content);
        else {
            const index = path.lastIndexOf('/');
            await this.engine.driver.createFile({ name: path.slice(index + 1),
                parentPath: path.slice(0, index) || '/', content, recursive: true });
        }
    }

    // ── 目录/文件辅助 ─────────────────────────────────────────

    /**
     * 确保目录存在（递归创建）
     */
    async ensureDirectory(path: string): Promise<void> {
        const fs = this.engine;
        const normalized = path.startsWith('/') ? path : '/' + path;
        const parts = normalized.split('/').filter(Boolean);

        let current: string | null = null;
        for (const part of parts) {
            const next: string = current ? `${current}/${part}` : `/${part}`;
            try {
                await fs.driver.createDirectory({ name: part, parentPath: current });
            } catch (e: unknown) {
                if (!isAlreadyExistsLike(e)) throw e;
            }
            current = next;
        }
    }

    /**
     * 删除文件（路径不存在时静默跳过）
     */
    protected async deleteFile(path: string): Promise<void> {
        const nodeId = await this.engine.driver.resolvePath(path);
        if (nodeId) {
            await this.engine.driver.delete([nodeId]);
        }
    }

    /**
     * 检查文件是否存在
     */
    protected async fileExists(path: string): Promise<boolean> {
        return this.engine.driver.exists(path);
    }

    // ── 变更通知 ──────────────────────────────────────────────

    onChange(listener: ChangeListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    protected notify(): void {
        this.listeners.forEach(l => {
            try {
                l();
            } catch (e) {
                console.error('[FileBackedService] Change listener error:', e);
            }
        });
    }
}

// ── 内部辅助 ─────────────────────────────────────────────────

function isAlreadyExistsLike(e: unknown): boolean {
    const code = getErrorCode(e);
    return (
        code === 'EEXIST' ||
        code === 'ALREADY_EXISTS' ||
        getErrorMessage(e).toLowerCase().includes('exist')
    );
}

function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : '';
}
