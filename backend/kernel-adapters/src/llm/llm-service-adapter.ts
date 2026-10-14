// @file: kernel-adapters/src/llm/llm-service-adapter.ts
// LLMServiceAdapter — 将 LLMDeviceDriver 的设备接口适配为简洁的 ILLMService。
//
// Process programs use ILLMService through the injected LLM resource port.
// 不直接感知 device driver 的 open/write/readStream 模式。

import type { ChatCompletionParams, ChatCompletionResponse, ChatCompletionChunk, ConnectionMeta, LLMProvider } from '@itookit/driver-llm/contracts';
import type { ILLMService } from '@itookit/driver-llm/contracts';
import type {
    IDeviceDriver,
    DeviceContext,
} from '@itookit/vfs-core';
import { LLM_IOCTL } from '../llm-management/contracts/device';

const BASE_CTX: DeviceContext = { nodeId: 'llm', name: 'llm' };

export class LLMServiceAdapter implements ILLMService {
    constructor(
        private readonly driver: IDeviceDriver,
        /** 运行模式；kernel 下层自动选 anthropic-messages 协议。 */
        private readonly runMode?: 'kernel',
    ) {}

    async chat(connectionId: string, request: ChatCompletionParams): Promise<ChatCompletionResponse> {
        const openOpts: Record<string, unknown> = { connectionId };
        if (this.runMode) openOpts.runMode = this.runMode;
        if (request._label) openOpts.sessionLabel = request._label;
        const sessionId = await this.driver.open?.(BASE_CTX, openOpts) ?? connectionId;
        const ctx: DeviceContext = { ...BASE_CTX, sessionId };

        try {
            const result = await this.driver.ioctl!(ctx, LLM_IOCTL.CHAT_SYNC, request);
            return result as ChatCompletionResponse;
        } finally {
            await this.driver.close?.(ctx);
        }
    }

    async *chatStream(connectionId: string, request: ChatCompletionParams): AsyncIterable<ChatCompletionChunk> {
        const openOpts: Record<string, unknown> = { connectionId };
        if (this.runMode) openOpts.runMode = this.runMode;
        if (request._label) openOpts.sessionLabel = request._label;
        const sessionId = await this.driver.open?.(BASE_CTX, openOpts) ?? connectionId;
        const ctx: DeviceContext = { ...BASE_CTX, sessionId };

        try {
            const raw = await this.driver.ioctl!(ctx, LLM_IOCTL.CHAT, request);
            const generator = raw as AsyncIterable<ChatCompletionChunk> | undefined;
            if (!generator) throw new Error('LLM driver did not return a stream');
            for await (const chunk of generator) yield chunk;
        } finally {
            await this.driver.close?.(ctx);
        }
    }

    abort(connectionId: string): void {
        this.driver.ioctl?.(
            { ...BASE_CTX, sessionId: connectionId },
            LLM_IOCTL.ABORT,
        ).catch(() => {});
    }

    async getConnection(connectionId: string): Promise<ConnectionMeta | undefined> {
        const result = await this.driver.ioctl?.(BASE_CTX, LLM_IOCTL.GET_CONNECTION_META, connectionId);
        return (result as ConnectionMeta | null) ?? undefined;
    }

    async getDefaultConnection(): Promise<ConnectionMeta | null> {
        const result = await this.driver.ioctl?.(BASE_CTX, LLM_IOCTL.GET_DEFAULT_CONNECTION);
        return (result as ConnectionMeta | null) ?? null;
    }

    async listConnections(): Promise<ConnectionMeta[]> {
        const result = await this.driver.ioctl?.(BASE_CTX, LLM_IOCTL.LIST_CONNECTIONS);
        return (result as ConnectionMeta[]) ?? [];
    }

    async getProvider(providerId: string): Promise<LLMProvider | undefined> {
        const result = await this.driver.ioctl?.(BASE_CTX, LLM_IOCTL.GET_PROVIDER, providerId);
        return (result as LLMProvider | null) ?? undefined;
    }

    estimateTokens(_connectionId: string, text: string): number {
        // Simple character-based approximation (4 chars per token)
        return Math.ceil(text.length / 4);
    }
}
