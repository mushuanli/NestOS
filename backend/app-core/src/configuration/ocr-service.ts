import { t } from '@itookit/common';
import { resolveModelId, type IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { type ModelTier, type LLMProvider, type ILLMService, type ConnectionMeta } from '@itookit/driver-llm/contracts';
import type { IFileSystem } from '@itookit/vfs-core';

export interface OcrSettings { connectionId?: string; systemPromptId: string }
export interface OcrConnection { connection: ConnectionMeta; modelId?: string; tier?: ModelTier; available: boolean; reason?: string }

/** Only consider models explicitly assigned to this connection, from lowest tier upward. */
function visionModel(connection: ConnectionMeta, providers: LLMProvider[]): { modelId: string; tier: ModelTier } | undefined {
    const provider = providers.find(item => item.id === connection.providerId);
    if (!provider) return;
    for (const tier of ['fast', 'standard', 'optimal'] as const) {
        const configured = connection.tiers?.[tier];
        if (!configured) continue;
        const id = resolveModelId(configured, provider, providers);
        if (provider.models.find(model => model.id === id)?.supportsVision === true) return { modelId: id!, tier };
    }
}
const path = '/llm/ocr.json';
const promptId = 'image-to-markdown';

/** Application policy: explicit OCR connection and a shared prompt, independent of chat. */
export class OcrService {
    private settings: OcrSettings = { systemPromptId: promptId };
    private tail: Promise<void> = Promise.resolve();
    private listeners = new Set<() => void>();
    constructor(private readonly fs: IFileSystem, private readonly agents: IAgentManagementService,
        private readonly llm: ILLMService) {}
    async init(): Promise<void> {
        if (await this.fs.driver.exists(path)) {
            const value = JSON.parse(await this.fs.driver.readContent(path, { encoding: 'utf-8' }));
            if (!value || typeof value.systemPromptId !== 'string' || (value.connectionId !== undefined && typeof value.connectionId !== 'string'))
                throw new Error(t('ocr.invalidSettings'));
            this.settings = { systemPromptId: value.systemPromptId, connectionId: value.connectionId }; return;
        }
        await this.preparePromptEditor();
        await this.persist(this.settings);
    }
    /** Explicit editing also recreates a deleted prompt; recognition never restores it silently. */
    async preparePromptEditor(): Promise<string> {
        const id = this.settings.systemPromptId;
        if (!await this.agents.getSystemPrompt(id)) await this.agents.saveSystemPrompt({
            id, name: t('ocr.promptName'), content: [t('ocr.promptContent')],
        });
        return id;
    }
    snapshot(): OcrSettings { return { ...this.settings }; }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
    async connections(): Promise<OcrConnection[]> {
        const providers = this.agents.getProviders();
        return (await this.agents.getConnections()).map(connection => {
            const selected = visionModel(connection, providers);
            const reason = !connection.enabled ? t('ocr.disabled') : !connection.hasApiKey && connection.providerId !== 'codex' ? t('ocr.noKey')
                : !selected ? t('ocr.noVision') : undefined;
            return { connection, ...selected, available: !reason, reason };
        });
    }
    async save(settings: OcrSettings): Promise<void> {
        const next = { ...settings };
        const work = this.tail.then(async () => {
            if (next.connectionId) await this.resolveConnection(next.connectionId);
            await this.resolvePrompt(next.systemPromptId);
            await this.persist(next); this.settings = next;
            for (const listener of this.listeners) listener();
        });
        this.tail = work.catch(() => {}); return work;
    }
    async label(): Promise<string> {
        const { connectionId } = this.settings;
        if (!connectionId) return t('ocr.unconfigured');
        const item = (await this.connections()).find(item => item.connection.id === connectionId);
        if (!item) return t('ocr.connectionMissing', { id: connectionId });
        return `${item.connection.name} · ${item.modelId ?? ''}${item.tier ? ' · ' + t(`ocr.tier.${item.tier}`) : ''}${item.reason ? ' · ' + item.reason : ''}`;
    }
    async ready(): Promise<boolean> {
        try { await this.resolveConnection(this.settings.connectionId); await this.resolvePrompt(this.settings.systemPromptId); return true; }
        catch { return false; }
    }
    async recognize(image: Blob, signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        const settings = this.snapshot();
        const [connection, prompt] = await Promise.all([this.resolveConnection(settings.connectionId), this.resolvePrompt(settings.systemPromptId)]);
        signal?.throwIfAborted();
        const response = await this.llm.chat(connection.connection.id, {
            model: connection.modelId,
            messages: [...prompt.content.map(content => ({ role: 'system' as const, content })), {
                role: 'user', content: t('ocr.request'),
                attachments: [{ type: 'image', source: image, mimeType: image.type || 'image/jpeg' }],
            }], maxTokens: 4096,
        });
        return response.choices?.[0]?.message?.content ?? '';
    }
    private async resolveConnection(id?: string): Promise<OcrConnection> {
        if (!id) throw new Error(t('ocr.unconfigured'));
        const item = (await this.connections()).find(item => item.connection.id === id);
        if (!item) throw new Error(t('ocr.connectionMissing', { id }));
        if (!item.available) throw new Error(`${item.connection.name}: ${item.reason}`);
        return item;
    }
    private async resolvePrompt(id: string) {
        const prompt = await this.agents.getSystemPrompt(id);
        if (!prompt || !prompt.content.some(text => text.trim())) throw new Error(t('ocr.promptMissing', { id }));
        return structuredClone(prompt);
    }
    private async persist(settings: OcrSettings): Promise<void> {
        const content = JSON.stringify(settings, null, 2);
        if (await this.fs.driver.exists(path)) await this.fs.driver.writeContent(path, content);
        else await this.fs.driver.createFile({ name: 'ocr.json', parentPath: '/llm', content, recursive: true });
    }
}
