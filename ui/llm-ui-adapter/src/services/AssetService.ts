// @file: llm-ui/services/AssetService.ts

import { FSError, type IFileSystem } from '@itookit/vfs-core';
import {randomUUID, sha256Hex, t} from '@itookit/common';
import type {ChatAttachment} from '@itookit/llm-session/contracts';

export interface PreparedAttachmentUpload {references: string[]; files: Omit<ChatAttachment, 'fileRef'>[];}

export function attachmentStorageName(submissionId: string, index: number, original: string): string {
    if (!/^[\w-]{1,128}$/.test(submissionId)) throw new FSError('EINVAL', t('chatInput.attachments.invalidIdentity'));
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
        if (!this.assets) throw new Error(t('chatInput.attachments.unavailable'));
        if (!fileName || /[\/\\\0]/.test(fileName) || fileName === '.' || fileName === '..') throw new FSError('EINVAL', t('chatInput.attachments.invalidName'));
        try { await this.assets.driver.createFile({name: fileName, parentPath: '/', content: data, overwrite: false}); }
        catch (error) {
            let stored: ArrayBuffer;
            try { stored = await this.assets.driver.readContent(`/${fileName}`, {encoding: 'binary'}); }
            catch { throw error; }
            const expected = new Uint8Array(data);
            if (stored.byteLength !== data.byteLength || !new Uint8Array(stored).every((byte, index) => byte === expected[index]))
                throw new FSError('EEXIST', t('chatInput.attachments.identityConflict'));
        }
    }

    /**
     * 批量上传文件并返回 Markdown 引用
     */
    async uploadFiles(files: File[], submissionId?: string): Promise<string[]> {
        return (await this.prepareUpload(files, submissionId)).references;
    }

    async prepareUpload(files: File[], submissionId?: string): Promise<PreparedAttachmentUpload> {
        const prepared: PreparedAttachmentUpload = {references: [], files: []};
        const operationId = submissionId ?? randomUUID();
        for (const [index, file] of files.entries()) {
            const result = await this.prepareFile(file, index, operationId, submissionId);
            prepared.references.push(result.reference); prepared.files.push(result.file);
        }
        return prepared;
    }

    private async prepareFile(file: File, index: number, operationId: string, submissionId?: string) {
        const started = Date.now(); let stage = 'file-read';
        try {
            const data = await file.arrayBuffer();
            const name = submissionId ? attachmentStorageName(submissionId, index, file.name) : file.name;
            stage = 'file-upload'; await this.createAsset(name, data);
            const metadata = {name, type: file.type, size: data.byteLength,
                content: {sha256: await sha256Hex(data), bytes: data.byteLength}};
            const label = file.name.replace(/[\\[\]]/g, '\\$&');
            console.debug('[AssetService] Attachment prepared', {operation: 'session.attachments', operationId,
                stage, outcome: 'success', index, bytes: data.byteLength, durationMs: Date.now() - started});
            return {file: metadata, reference: `${file.type.startsWith('image/') ? '!' : ''}[${label}](@asset/${name})`};
        } catch (error) {
            const code = error instanceof FSError ? error.code : stage === 'file-read' ? 'ATTACHMENT_READ_FAILED' : 'ATTACHMENT_UPLOAD_FAILED';
            console.error('[AssetService] Attachment preparation failed', {operation: 'session.attachments', operationId,
                stage, outcome: 'failure', code, index, durationMs: Date.now() - started});
            if (error instanceof FSError) throw error;
            throw Object.assign(new Error(stage === 'file-read' ? t('chatInput.attachments.readFailed')
                : t('chatInput.attachments.uploadFailed')), {code});
        }
    }
}
