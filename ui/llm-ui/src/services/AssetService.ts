// @file: llm-ui/services/AssetService.ts

import { FSError, type IFileSystem } from '@itookit/vfs-core';

/**
 * 资源管理服务
 * 职责：附件的上传、获取、管理
 */
export class AssetService {
    constructor(private readonly assets?: IFileSystem) { }

    /**
     * 创建资源
     */
    async createAsset(fileName: string, data: ArrayBuffer): Promise<void> {
        if (!this.assets) throw new Error('Session attachments unavailable');
        if (!fileName || /[\/\\\0]/.test(fileName) || fileName === '.' || fileName === '..') throw new FSError('EINVAL', 'Invalid attachment name');
        await this.assets.driver.createFile({ name: fileName, parentPath: '/', content: data, overwrite: true });
    }

    /**
     * 批量上传文件并返回 Markdown 引用
     */
    async uploadFiles(files: File[]): Promise<string[]> {
        const refs: string[] = [];

        for (const file of files) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                await this.createAsset(file.name, arrayBuffer);


                const isImage = file.type.startsWith('image/');
                const ref = isImage
                    ? `![${file.name}](@asset/${file.name})`
                    : `[📄 ${file.name}](@asset/${file.name})`;

                refs.push(ref);
            } catch (e) {
                console.error(`[AssetService] Failed to upload ${file.name}:`, e);
                throw new Error(`Failed to upload ${file.name}`);
            }
        }

        return refs;
    }
}
