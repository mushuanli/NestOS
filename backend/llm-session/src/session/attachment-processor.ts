// @file: llm-conversation/session/attachment-processor.ts

import { guessMimeType } from '@itookit/vfs-core';
import type { Attachment } from '@itookit/llm-context';
import { ChatAttachment } from '../core/types';
import { ISessionRepository } from '../persistence/types';
import { MarkdownAnalyzer } from './MarkdownAnalyzer';

/**
 * 附件处理器
 * 负责解析消息中的文件引用、文件格式转换
 */
export class AttachmentProcessor {
    private markdownAnalyzer = new MarkdownAnalyzer();

    constructor(private engine: ISessionRepository) { }

    /**
     * 从消息文本和输入文件中解析所有附件
     */
    async resolveAttachments(
        sessionId: string,
        text: string,
        inputFiles: ChatAttachment[]
    ): Promise<ChatAttachment[]> {
        const result: ChatAttachment[] = [];
        const seen = new Set<string>();

        // 从 Markdown 中提取引用的文件名
        const analysis = await this.markdownAnalyzer.analyze(text, { filePath: 'message.md' });

        // 优先处理 Markdown 引用的文件
        for (const filename of analysis.references) {
            if (seen.has(filename)) continue;
            seen.add(filename);

            // 优先从输入文件中查找（内存）
            const memoryFile = inputFiles.find((f) => f.name === filename);
            if (memoryFile) {
                result.push(memoryFile);
                continue;
            }

            // 从持久化层读取
            const loaded = await this.loadFromStorage(sessionId, filename);
            if (loaded) {
                result.push(loaded);
            }
        }

        // 包含未被引用的输入文件
        for (const file of inputFiles) {
            if (!seen.has(file.name)) {
                result.push(file);
                seen.add(file.name);
            }
        }

        return result;
    }

    /**
     * 将 ChatAttachment 数组转换为 Kernel 可用的 Attachment 数组
     */
    async convertToAttachments(sessionId: string, files: ChatAttachment[]): Promise<Attachment[]> {
        const attachments: Attachment[] = [];

        for (const file of files) {
            const source = await this.resolveFileSource(sessionId, file);
            if (!source) {
                console.warn(`[AttachmentProcessor] Skipping unresolvable file: ${file.name}`);
                continue;
            }

            const mimeType = file.type || guessMimeType(file.name);
            attachments.push({
                type: this.mimeToAttachmentType(mimeType),
                source,
                mimeType,
                filename: file.name,
            });
        }

        return attachments;
    }

    /**
     * 加载历史消息中的附件并转换为 Attachment
     */
    async resolveHistoryAttachment(
        sessionId: string,
        file: ChatAttachment
    ): Promise<Attachment | null> {
        try {
            const blob = file.fileRef || (await this.engine.readSessionAsset(sessionId, file.name));
            if (!blob) return null;

            const mimeType = file.type || guessMimeType(file.name);
            return {
                type: this.mimeToAttachmentType(mimeType),
                source: blob,
                mimeType,
                filename: file.name,
            };
        } catch (e) {
            console.warn(`[AttachmentProcessor] Failed to load attachment: ${file.name}`, e);
            return null;
        }
    }

    /**
     * 剥离 fileRef 用于持久化（不序列化运行时对象）
     */
    stripFileRefs(files: ChatAttachment[]): Omit<ChatAttachment, 'fileRef'>[] {
        return files.map((f) => ({
            name: f.name,
            type: f.type,
            path: f.path,
            size: f.size,
        }));
    }

    /**
     * MIME 类型 -> 附件分类
     */
    mimeToAttachmentType(mimeType: string): 'image' | 'audio' | 'video' | 'file' {
        if (!mimeType) return 'file';
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('audio/')) return 'audio';
        if (mimeType.startsWith('video/')) return 'video';
        return 'file';
    }

    // ============================================
    // 内部方法
    // ============================================

    private async loadFromStorage(sessionId: string, filename: string): Promise<ChatAttachment | null> {
        try {
            const blob = await this.engine.readSessionAsset(sessionId, filename);
            if (!blob) return null;

            return {
                name: filename,
                type: blob.type || guessMimeType(filename),
                path: `./${filename}`,
                size: blob.size,
                fileRef: blob,
            };
        } catch (e) {
            console.error(`[AttachmentProcessor] Failed to load: ${filename}`, e);
            return null;
        }
    }

    private async resolveFileSource(sessionId: string, file: ChatAttachment): Promise<File | Blob | null> {
        if (file instanceof File) return file;
        if (file.fileRef instanceof File) return file.fileRef;
        if (file.fileRef instanceof Blob) return file.fileRef;

        if (file.path || file.name) {
            try {
                const blob = await this.engine.readSessionAsset(sessionId, file.name);
                if (blob) return blob;
            } catch {
                // ignore
            }
        }

        return null;
    }
}
