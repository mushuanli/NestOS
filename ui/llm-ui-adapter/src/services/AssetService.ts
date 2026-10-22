// @file: llm-ui/services/AssetService.ts

import { FSError, type IFileSystem } from '@itookit/vfs-core';

export function attachmentStorageName(submissionId: string, index: number, original: string): string {
    if (!/^[\w-]{1,128}$/.test(submissionId)) throw new FSError('EINVAL', 'Invalid attachment submission identity');
    return `${submissionId}-${index}${original.match(/\.[a-zA-Z0-9]{1,16}$/)?.[0] ?? ''}`;
}

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
    async uploadFiles(files: File[], submissionId?: string): Promise<string[]> {
        const refs: string[] = [];

        for (const [index, file] of files.entries()) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const storedName = submissionId ? attachmentStorageName(submissionId, index, file.name) : file.name;
                await this.createAsset(storedName, arrayBuffer);


                const isImage = file.type.startsWith('image/');
                const label = file.name.replace(/[\\[\]]/g, '\\$&');
                const ref = isImage
                    ? `![${label}](@asset/${storedName})`
                    : `[${label}](@asset/${storedName})`;

                refs.push(ref);
            } catch (e) {
                console.error(`[AssetService] Failed to upload ${file.name}:`, e);
                throw new Error(`Failed to upload ${file.name}`);
            }
        }

        return refs;
    }
}
