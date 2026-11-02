import {createImageProcessor, resolveResize, type ImageProcessor, type ImageResizePolicy, type ImageSource, type ImageSpec} from '@itookit/image-parser';
import {randomUUID, t} from '@itookit/common';

/** Product default; explicit user and agent policies retain precedence. */
export function resolveChatImageResize(override?: ImageResizePolicy, agent?: ImageResizePolicy): ImageResizePolicy {
    return resolveResize(override, agent ?? {mode: 'max-edge', maxEdge: 1600});
}

/** Shared processing ownership and policy checks for both composer adapters. */
export class ImageProcessingSession {
    private processor?: ImageProcessor;
    private readonly lifetime = new AbortController();
    constructor(private readonly resize: () => ImageResizePolicy, private readonly borrowed?: ImageProcessor) {}
    get engine(): ImageProcessor {return this.processor ??= this.borrowed ?? createImageProcessor();}
    getResize(): ImageResizePolicy {return resolveResize(this.resize());}
    getKey(resize = this.getResize()): string {return imageProcessingKey(resize, this.engine);}
    assertPolicy(resize: ImageResizePolicy, signal: AbortSignal): void {
        this.lifetime.signal.throwIfAborted(); signal.throwIfAborted();
        if (JSON.stringify(this.getResize()) !== JSON.stringify(resize)) throw new Error(t('image.conflict'));
    }
    async process(source: ImageSource, spec: ImageSpec, signal: AbortSignal, resize = this.getResize(), mimeType?: string) {
        this.assertPolicy(resize, signal);
        const operationId = randomUUID(), started = performance.now();
        try {
            const output = await this.engine.process(source, spec, {signal, resize, recipe: mimeType === 'image/jpeg'
                ? {version: 1, resize, color: 'preserve', output: {mimeType: 'image/jpeg', quality: 0.82}} : undefined});
            this.assertPolicy(resize, signal);
            if (output.purpose !== 'export') throw new Error(t('image.conflict'));
            console.debug('[Chat image]', {operation: 'image.prepare', stage: 'encode', result: 'success', operationId,
                durationMs: Math.round(performance.now() - started), width: output.width, height: output.height,
                bytes: output.byteLength, mimeType: output.mimeType});
            return output;
        } catch (failure) {
            console.warn('[Chat image]', {operation: 'image.prepare', stage: 'encode', result: 'failure', operationId,
                durationMs: Math.round(performance.now() - started), code: signal.aborted ? 'ABORTED'
                    : failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : 'IMAGE_PROCESSING_FAILED'});
            throw failure;
        }
    }
    async dispose(): Promise<void> {this.lifetime.abort(); if (!this.borrowed) await this.processor?.dispose();}
}

export function imageProcessingKey(resize: ImageResizePolicy, processor: ImageProcessor): string {
    return JSON.stringify([resize, processor.id, processor.version]);
}
