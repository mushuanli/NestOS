import { assertEffectGrant, type EffectAdapter, type EffectExecutionContext, type EffectReconcileResult } from '@itookit/durable-kernel';
import { validateMediaRequest, type ILLMService, type MediaGenerationInput, type MediaGenerationRequest, type MediaGenerationResult, type TokenUsage } from '@itookit/driver-llm/contracts';
import { assertModelConnection, mediaEndpointIdentity, type ModelConnectionSnapshot } from '../llm-management/contracts/model-requirements';
import { InFlightEffects } from './in-flight';
export interface MediaAssetReference { sessionId: string; taskId: string; owner: string; name: string; mimeType: string; bytes: number; sha256: string }
export interface StoredMediaResult { model: string; assets: MediaAssetReference[]; usage?: TokenUsage }
export interface LlmMediaEffectRequest { resourceHandleId: string; connectionId: string; connectionSnapshot?: ModelConnectionSnapshot; request: MediaGenerationInput }
export interface MediaResultStore {
    get(request: LlmMediaEffectRequest, context: EffectExecutionContext): Promise<StoredMediaResult | undefined>;
    put(request: LlmMediaEffectRequest, result: MediaGenerationResult, context: EffectExecutionContext): Promise<StoredMediaResult>;
}
export type AuthorizeMedia = (request: LlmMediaEffectRequest, context: EffectExecutionContext) => Promise<void>;
/** Paid requests are never retried automatically; only durable local receipts can resolve recovery. */
export class LlmMediaEffectAdapter implements EffectAdapter<LlmMediaEffectRequest, StoredMediaResult> {
    readonly kind = 'llm.media'; readonly version = '1';
    private readonly inFlight = new InFlightEffects();
    constructor(private readonly service: ILLMService, private readonly store: MediaResultStore, private readonly authorize?: AuthorizeMedia) {}
    execute(request: LlmMediaEffectRequest, context: EffectExecutionContext): Promise<StoredMediaResult> { return this.inFlight.track(context, this.run(request, context)); }
    async cancel(_request: LlmMediaEffectRequest, context: EffectExecutionContext): Promise<void> { await this.inFlight.confirmStopped(context); }
    shouldRetry(): boolean { return false; }
    reconcile(request: LlmMediaEffectRequest, context: EffectExecutionContext): Promise<EffectReconcileResult<StoredMediaResult>> {
        return this.inFlight.track(context, this.recover(request, context));
    }
    private async recover(request: LlmMediaEffectRequest, context: EffectExecutionContext): Promise<EffectReconcileResult<StoredMediaResult>> {
        assertEffectGrant(context, request.resourceHandleId, 'llm'); await this.authorize?.(request, context);
        const result = await this.store.get(request, context);
        if (!result) return { status: 'indeterminate', error: { code: 'MEDIA_INDETERMINATE', message: 'Media outcome has no durable receipt; explicit retry may incur another charge' } };
        await chargeUsage(request, result, context); return { status: 'completed', result };
    }
    private async run(request: LlmMediaEffectRequest, context: EffectExecutionContext): Promise<StoredMediaResult> {
        assertEffectGrant(context, request.resourceHandleId, 'llm'); await this.authorize?.(request, context);
        await assertMediaConnection(this.service, request); context.abortSignal.throwIfAborted();
        const existing = await this.store.get(request, context);
        if (existing) { await chargeUsage(request, existing, context); return existing; }
        if (!this.service.generateMedia) throw new Error('Media runtime is unavailable');
        await this.authorize?.(request, context); await assertMediaConnection(this.service, request); context.abortSignal.throwIfAborted();
        const response = await this.service.generateMedia(request.connectionId, { ...request.request, signal: context.abortSignal } as MediaGenerationRequest);
        const result = await this.store.put(request, response, context);
        await chargeUsage(request, result, context); return result;
    }
}
export async function assertMediaConnection(service: ILLMService, request: LlmMediaEffectRequest): Promise<void> {
    if (!request.connectionId?.trim() || !request.request.model) throw new Error('Explicit media connection and model are required');
    const connection = await service.getConnection(request.connectionId), provider = connection && await service.getProvider(connection.providerId);
    const requirements = { operation: request.request.operation, inputModalities: ['text'], outputModalities: [request.request.operation === 'image.generate' ? 'image' : 'audio'] };
    assertModelConnection(connection, provider, request.request.model, requirements);
    const saved = request.connectionSnapshot;
    if (saved && (connection!.providerId !== saved.providerId || connection!.protocol !== saved.protocol || request.request.model !== saved.modelId
        || saved.mediaEndpoint !== mediaEndpointIdentity(provider!, connection!.baseURL, requirements.operation))) throw new Error('Media connection changed after admission');
    if (saved?.requirements) assertModelConnection(connection, provider, request.request.model, saved.requirements);
    validateMediaRequest(provider!, request.request as MediaGenerationRequest);
}
async function chargeUsage(request: LlmMediaEffectRequest, result: StoredMediaResult, context: EffectExecutionContext): Promise<void> {
    const tokens = result.usage?.total_tokens;
    if (tokens) await context.chargeBudget?.(request.resourceHandleId, 'tokens', tokens, { usageId: `media:${context.taskId}:${context.effectId}:tokens` });
}
