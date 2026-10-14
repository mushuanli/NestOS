// @file: llm-conversation/src/utils/vfs-entity-store.ts

import { FileBackedService } from './file-backed-service';
import { createSessionHost, type SessionHost } from './host-ports';

/**
 * VFS JSON 实体的通用 CRUD 配置
 */
export interface EntityStoreConfig {
    /** 存储目录（相对于模块根） */
    dir: string;
    /** 显示图标 */
    icon: string;
    /** 类型标识 */
    typeName: string;
}

/**
 * 实体需要满足的最小接口
 */
export interface Identifiable {
    id: string;
    name: string;
}

/**
 * VFS JSON 实体通用存储操作
 *
 * 提取 saveConnection/saveMCPServer/deleteConnection/deleteMCPServer 的公共模式，
 * 通过组合方式供 VFSAgentService 使用。
 */
export class VFSEntityStore<T extends Identifiable> {
    constructor(
        private service: FileBackedService,
        private engine: FileBackedService['engine'],
        private config: EntityStoreConfig,
        private readonly host: SessionHost = createSessionHost()
    ) { }

    /**
     * 保存实体（新建或更新），同步更新内存缓存
     */
    async save(entity: T, cache: T[]): Promise<T[]> {
        const filename = `${entity.id}.json`;
        const content = JSON.stringify(entity, null, 2);
        const fullPath = `${this.config.dir}/${filename}`;
        const metadata = {
            icon: this.config.icon,
            title: entity.name,
            type: this.config.typeName
        };

        await this.service.ensureDirectory(this.config.dir);
        const nodeId = await this.engine.driver.resolvePath(fullPath);

        if (nodeId) {
            await this.engine.driver.writeContent(nodeId, content);
            await this.engine.driver.updateMetadata(nodeId, metadata);
        } else {
            await this.engine.driver.createFile({
                name: filename,
                parentPath: this.config.dir,
                content,
                metadata,
            });
        }

        // 更新缓存
        const newCache = [...cache];
        const index = newCache.findIndex(c => c.id === entity.id);
        if (index >= 0) {
            newCache[index] = entity;
        } else {
            newCache.push(entity);
        }

        return newCache;
    }

    /**
     * 删除实体，返回过滤后的缓存
     */
    async delete(id: string, cache: T[]): Promise<T[]> {
        const fullPath = `${this.config.dir}/${id}.json`;
        const nodeId = await this.engine.driver.resolvePath(fullPath);

        if (nodeId) {
            await this.engine.driver.delete([nodeId]);
            this.host.logger.debug(`${this.config.typeName} file deleted`, { id });
        }

        return cache.filter(c => c.id !== id);
    }
}
