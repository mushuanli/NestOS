// @file: llm-conversation/services/prompt-history-service.ts

import YAML from 'yaml';
import { FileBackedService } from '../utils/file-backed-service';
import type { IFileSystem } from '@itookit/vfs-core';
import { createSessionHost, type SessionHost } from '../utils/host-ports';

// ============================================
// 类型定义
// ============================================

import type { PromptHistoryEntry, HistoryQueryOptions } from '../contracts/prompt-history';
export type { PromptHistoryEntry, HistoryQueryOptions } from '../contracts/prompt-history';

/**
 * 历史文件结构（YAML 序列化格式）
 */
interface PromptHistoryFile {
    version: 1;
    max_entries: number;
    entries: PromptHistoryEntry[];
}

// ============================================
// 常量
// ============================================

/** prompt 历史属于 chat 功能，存放在 chat 模块内 */

/** __config/ 是模块标准内部目录，文件名无需 _ 前缀 */
const HISTORY_FILE = '/__config/history.yaml';

const DEFAULT_MAX_ENTRIES = 500;
const WRITE_DEBOUNCE_MS = 1500;
const MIN_PROMPT_LENGTH = 2;

/**
 * Prompt History 服务
 *
 * 继承 FileBackedService，数据存储在 chats:/_history.yaml
 *
 * 职责：
 * - 记录用户输入的 prompt（全局，跨会话）
 * - 去重（相同文本只保留最新记录）
 * - 模糊搜索和过滤
 * - 持久化到 chats:/_history.yaml
 *
 * 设计要点：
 * - 懒加载：首次访问时才读取文件
 * - 防抖写入：避免高频 I/O
 * - 容量限制：超出时淘汰最旧条目
 * - 降级安全：初始化失败不影响主流程
 */
export class PromptHistoryService extends FileBackedService {
    private entries: PromptHistoryEntry[] = [];
    private maxEntries = DEFAULT_MAX_ENTRIES;
    private loaded = false;
    private dirty = false;
    private writeTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(fs: IFileSystem, private readonly host: SessionHost = createSessionHost()) {
        super(fs, host.logger);
    }

    protected async onLoad(): Promise<void> {
        // FileBackedService.init() 会调用此方法
        // 此时 engine 已就绪，但不急于加载数据（懒加载）
        this.host.logger.debug('PromptHistoryService module ready');
    }

    // ============================================
    // 核心 API
    // ============================================

    /**
     * 添加一条 prompt 到历史
     *
     * 行为：
     * - 忽略过短的输入（< 2 字符）
     * - 去重：相同文本已存在则更新时间戳并提升到顶部
     * - 容量控制：超出 maxEntries 时淘汰最旧条目
     * - 防抖持久化
     */
    async add(
        text: string,
        context?: { agentId?: string; sessionId?: string }
    ): Promise<void> {
        const trimmed = text.trim();
        if (trimmed.length < MIN_PROMPT_LENGTH) return;

        await this.ensureLoaded();

        // 去重：移除已存在的相同文本
        const existingIndex = this.entries.findIndex(
            (e) => e.text === trimmed
        );
        if (existingIndex !== -1) {
            this.entries.splice(existingIndex, 1);
        }

        // 插入到头部（最新优先）
        this.entries.unshift({
            text: trimmed,
            timestamp: Date.now(),
            agentId: context?.agentId,
            sessionId: context?.sessionId,
        });

        // 容量控制
        if (this.entries.length > this.maxEntries) {
            this.entries = this.entries.slice(0, this.maxEntries);
        }

        this.dirty = true;
        this.schedulePersist();
    }

    /**
     * 搜索历史记录
     *
     * 支持：
     * - 模糊搜索（大小写不敏感）
     * - 按 agent 过滤
     * - 分页
     */
    async search(options?: HistoryQueryOptions): Promise<PromptHistoryEntry[]> {
        await this.ensureLoaded();

        let results = [...this.entries];

        // 按 agent 过滤
        if (options?.agentId) {
            results = results.filter((e) => e.agentId === options.agentId);
        }

        // 模糊搜索
        if (options?.query) {
            const queryLower = options.query.toLowerCase();
            results = results.filter((e) =>
                e.text.toLowerCase().includes(queryLower)
            );
        }

        // 分页
        const offset = options?.offset ?? 0;
        const limit = options?.limit ?? 50;
        return results.slice(offset, offset + limit);
    }

    /**
     * 获取最近的 N 条记录
     */
    async getRecent(count: number = 20): Promise<PromptHistoryEntry[]> {
        await this.ensureLoaded();
        return this.entries.slice(0, Math.max(0, count));
    }

    /**
     * 获取全部记录数
     */
    async getCount(): Promise<number> {
        await this.ensureLoaded();
        return this.entries.length;
    }

    /**
     * 删除单条记录
     */
    async remove(text: string): Promise<boolean> {
        await this.ensureLoaded();

        const trimmed = text.trim();
        const index = this.entries.findIndex((e) => e.text === trimmed);
        if (index === -1) return false;

        this.entries.splice(index, 1);
        this.dirty = true;
        this.schedulePersist();
        return true;
    }

    /**
     * 清空全部历史
     */
    async clear(): Promise<void> {
        this.entries = [];
        this.dirty = true;
        await this.persistNow();
    }

    // ============================================
    // 持久化
    // ============================================

    /**
     * 立即持久化（用于应用退出前）
     */
    async persistNow(): Promise<void> {
        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }

        if (!this.dirty) return;

        try {
            const file: PromptHistoryFile = {
                version: 1,
                max_entries: this.maxEntries,
                entries: this.entries,
            };

            const yamlContent = YAML.stringify(file, {
                indent: 2,
                lineWidth: 0,
            });

            // 使用 FileBackedService 的 writeJson 等效逻辑
            // 但写 YAML 而非 JSON
            await this.writeYaml(HISTORY_FILE, yamlContent);
            this.dirty = false;

            this.host.logger.debug('Prompt history persisted', {
                count: this.entries.length,
            });
        } catch (e) {
            this.host.logger.error('Failed to persist prompt history', { error: e });
        }
    }

    // ============================================
    // 生命周期
    // ============================================

    async dispose(): Promise<void> {
        // 确保退出前持久化
        await this.persistNow();

        if (this.writeTimer) {
            clearTimeout(this.writeTimer);
            this.writeTimer = null;
        }

        await super.dispose();
    }

    // ============================================
    // 内部方法
    // ============================================

    /**
     * 懒加载：首次访问时从磁盘读取
     */
    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return;

        try {
            const content = await this.readYaml<PromptHistoryFile>(HISTORY_FILE);

            if (content && content.version === 1 && Array.isArray(content.entries)) {
                this.entries = content.entries;
                this.maxEntries = content.max_entries || DEFAULT_MAX_ENTRIES;

                this.host.logger.debug('Prompt history loaded', {
                    count: this.entries.length,
                });
            }
        } catch (e) {
            this.host.logger.warn('Failed to load prompt history, starting fresh', { error: e });
            this.entries = [];
        }

        this.loaded = true;
    }

    /**
     * 防抖写入调度
     */
    private schedulePersist(): void {
        if (this.writeTimer) return;

        this.writeTimer = setTimeout(async () => {
            this.writeTimer = null;
            await this.persistNow();
        }, WRITE_DEBOUNCE_MS);
    }

    /**
     * 读取 YAML 文件
     * 复用 FileBackedService 的 VFS 读取能力
     */
    private async readYaml<T>(path: string): Promise<T | null> {
        try {
            const content = await this.engine.driver.readContent(path);
            const str = typeof content === 'string'
                ? content
                : new TextDecoder().decode(content as ArrayBuffer);
            return YAML.parse(str) as T;
        } catch (e: any) {
            const isNotFound =
                e.message?.toLowerCase().includes('not found') ||
                e.code === 'NOT_FOUND';
            if (!isNotFound) {
                this.host.logger.warn('Failed to read YAML', { path, error: e });
            }
            return null;
        }
    }

    /**
     * 写入 YAML 文件
     * 复用 FileBackedService 的 VFS 写入能力
     */
    private async writeYaml(path: string, yamlContent: string): Promise<void> {
        const existingId = await this.engine.driver.resolvePath(path);

        if (existingId) {
            await this.engine.driver.writeContent(existingId, yamlContent);
        } else {
            const lastSlash = path.lastIndexOf('/');
            const parentPath = lastSlash > 0 ? path.slice(0, lastSlash) : null;
            const fileName = path.slice(lastSlash + 1);

            if (parentPath && parentPath !== '/') {
                await this.ensureDirectory(parentPath);
            }

            await this.engine.driver.createFile({
                name: fileName,
                parentPath: parentPath,
                content: yamlContent,
            });
        }
    }
}
