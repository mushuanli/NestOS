import type {ChatCompletionParams} from '@itookit/driver-llm/contracts';
import type {EffectExecutionContext} from '@itookit/durable-kernel';
import type {TaskAssetReader, BinaryAssetReference} from '@itookit/tools/contracts';

/** Expand only at provider dispatch; persisted requests and diagnostics retain references. */
export async function materializeAssetMessages(request: ChatCompletionParams, context: EffectExecutionContext,
    read?: TaskAssetReader): Promise<ChatCompletionParams> {
    let total = 0;
    const visit = async (value: unknown): Promise<unknown> => {
        if (Array.isArray(value)) return Promise.all(value.map(visit));
        if (!value || typeof value !== 'object') return value;
        const part = value as {type?: string; source?: {type?: string; asset?: BinaryAssetReference}};
        if (part.type === 'image' && part.source?.type === 'asset') {
            if (!read || !part.source.asset) throw new Error('Image asset reader is unavailable');
            const ref = part.source.asset;
            if (!/^image\/(png|jpeg|webp)$/.test(ref.mimeType) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1) throw new Error('Invalid model image asset');
            total += ref.bytes;
            if (total > 32 * 1024 * 1024) throw new Error('Model image assets exceed dispatch budget');
            context.abortSignal.throwIfAborted();
            const bytes = await read(ref, {...context, operationId: context.effectId});
            context.abortSignal.throwIfAborted();
            return {type: 'image_url', image_url: {url: `data:${ref.mimeType};base64,${base64(bytes)}`}};
        }
        return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await visit(item)])));
    };
    return {...request, messages: await visit(request.messages) as ChatCompletionParams['messages']};
}
function base64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    return btoa(binary);
}
