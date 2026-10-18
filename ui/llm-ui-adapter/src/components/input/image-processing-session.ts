import {createImageProcessor, resolveResize, type ImageProcessor, type ImageResizePolicy, type ImageSource, type ImageSpec} from '@itookit/image-parser';
import {t} from '@itookit/common';

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
    async process(source: ImageSource, spec: ImageSpec, signal: AbortSignal, resize = this.getResize()) {
        this.assertPolicy(resize, signal);
        const output = await this.engine.process(source, spec, {signal, resize});
        this.assertPolicy(resize, signal);
        if (output.purpose !== 'export') throw new Error(t('image.conflict'));
        return output;
    }
    async dispose(): Promise<void> {this.lifetime.abort(); if (!this.borrowed) await this.processor?.dispose();}
}

export function imageProcessingKey(resize: ImageResizePolicy, processor: ImageProcessor): string {
    return JSON.stringify([resize, processor.id, processor.version]);
}
