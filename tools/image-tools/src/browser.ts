import {IMAGE_PROCESSOR_VERSION} from '@itookit/image-parser/processing';
import {createImageProcessor, createBlobSource, DEFAULT_IMAGE_SPEC} from '@itookit/image-parser';
import {createImageTools} from './core';
import type {ImageEngine} from './contract';
export function createBrowserImageTools() {
    const engine: ImageEngine = {id: 'canvas-image-parser', version: `1/${IMAGE_PROCESSOR_VERSION}/${typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent}`,  async process(data, recipe, signal) {
        const processor = createImageProcessor();
        try {
            const result = await processor.process(createBlobSource(new Blob([new Uint8Array(data).buffer]), {id: 'tool-source', revision: '1', name: 'image'}), DEFAULT_IMAGE_SPEC, {signal, recipe});
            return {data: new Uint8Array(await result.blob.arrayBuffer()), mimeType: result.mimeType, width: result.width, height: result.height};
        } finally {await processor.dispose();}
    }};
    return createImageTools(engine);
}
