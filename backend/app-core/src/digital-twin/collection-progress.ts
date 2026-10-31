import type {TwinCollectionProgress} from '@itookit/app-contracts';

/** Only the reserved, versioned receipt is interpreted; provider cursors and business results stay opaque. */
export function collectionProgress(output: unknown): TwinCollectionProgress | undefined {
    const wrapped = output as {outputs?: {result?: {content?: unknown}}; nodes?: {__flow_return?: {outputs?: {result?: {content?: unknown}}}}};
    const value = (wrapped?.outputs?.result?.content ?? wrapped?.nodes?.__flow_return?.outputs?.result?.content ?? output) as
        {collection?: TwinCollectionProgress; result?: {collection?: TwinCollectionProgress}} | undefined;
    const progress = value?.collection ?? value?.result?.collection;
    if (!progress || progress.version === undefined) return;
    if (progress?.version !== 1 || typeof progress.complete !== 'boolean' || !Number.isSafeInteger(progress.processed) || progress.processed < 0)
        throw new Error('TWIN_COLLECTION_RESULT_INVALID');
    if (progress.batchCount !== undefined && (!Number.isSafeInteger(progress.batchCount) || progress.batchCount < 0))
        throw new Error('TWIN_COLLECTION_RESULT_INVALID');
    return {version: 1, complete: progress.complete, processed: progress.processed,
        ...(progress.batchCount !== undefined ? {batchCount: progress.batchCount} : {})};
}
