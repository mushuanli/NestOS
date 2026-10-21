import { createModuleLogger, randomUUID } from '@itookit/common';
import type { FlowImageConstraints } from '@itookit/llm-flow/contracts';

const log = createModuleLogger('flow-images');
export class FlowImageError extends Error {
    constructor(readonly stage: string, readonly code: string, message: string, readonly requestId?: string) { super(message); }
}

/** Keep filenames, data URLs and exception messages out of diagnostic records. */
export function imageSelectionTrace(files: File[], field: number, constraints: FlowImageConstraints) {
    const started = performance.now(), operationId = randomUUID();
    const metadata = { operationId, field, count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0),
        mimeTypes: [...new Set(files.map(file => /^image\/[a-z0-9.+-]{1,32}$/i.test(file.type) ? file.type.toLowerCase() : 'unknown'))],
        maxItems: constraints.maxItems, maxBytes: constraints.maxBytes, allowedMimeTypes: constraints.mimeTypes };
    return {
        step(stage: string, index?: number) { log.info('image.selection', { ...metadata, stage, index, durationMs: Math.round(performance.now() - started) }); },
        fail(error: unknown) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            log.warn('image.selection.failed', { ...metadata, stage: error instanceof FlowImageError ? error.stage : 'upload',
                ...(error instanceof FlowImageError && error.requestId && /^[a-f0-9-]{36}$/.test(error.requestId) ? {requestId: error.requestId} : {}),
                code: error instanceof FlowImageError ? error.code : 'UNEXPECTED', durationMs: Math.round(performance.now() - started) });
        },
    };
}
