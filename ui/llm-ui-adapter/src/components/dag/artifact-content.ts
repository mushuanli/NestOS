import {createModuleLogger, randomUUID} from '@itookit/common';
import {ArtifactCommand, type ExecutionArtifactChunk, type ExecutionArtifactDescriptor, type ExecutionArtifactReference} from '@itookit/app-contracts';
import type {ICommandBus} from '@itookit/llm-session/contracts';
import {readVerifiedContent, type VerifiedContentOptions} from '../../utils/verified-content';

export type ArtifactReadOptions = VerifiedContentOptions;

/** Byte offsets and fingerprints remain pinned across every page of one read. */
export async function readArtifactContent(commands: ICommandBus, artifact: ExecutionArtifactDescriptor, options: ArtifactReadOptions) {
    if (artifact.kind === 'unavailable') throw failure('ARTIFACT_UNAVAILABLE');
    const operationId = randomUUID();
    const started = Date.now();
    try {return await readVerifiedContent({bytes: artifact.bytes!, sha256: artifact.sha256!}, async (offset, limit) => {
        const chunk = await commands.execute<ExecutionArtifactChunk>(ArtifactCommand.Read, {reference: artifact.reference, offset, limit, operationId});
        validateChunk(chunk, artifact, offset, limit); return {data: chunk.data, nextOffset: chunk.nextOffset};
    }, options);}
    catch (error) {
        const code = (error as {code?: unknown})?.code;
        try {createModuleLogger('execution-artifact-ui').warn('Artifact content read failed', {operationId, stage: 'read-verify',
            outcome: options.signal.aborted ? 'cancelled' : 'failure', durationMs: Date.now() - started,
            code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'ARTIFACT_READ_FAILED'});} catch { /* Diagnostics cannot alter the read result. */ }
        throw error;
    }
}

function validateChunk(chunk: ExecutionArtifactChunk, artifact: ExecutionArtifactDescriptor, offset: number, limit: number): void {
    if (!chunk || !sameReference(chunk.reference, artifact.reference) || !(chunk.data instanceof ArrayBuffer)) throw failure('ARTIFACT_RESPONSE_INVALID');
    const expected = {offset, totalBytes: artifact.bytes, sha256: artifact.sha256, mimeType: artifact.mimeType};
    if (!Object.entries(expected).every(([key, value]) => chunk[key as keyof ExecutionArtifactChunk] === value)) throw failure('ARTIFACT_RESPONSE_INVALID');
    const end = offset + chunk.data.byteLength, complete = end === chunk.totalBytes;
    if (chunk.data.byteLength > limit || end > chunk.totalBytes) throw failure('ARTIFACT_RESPONSE_INVALID');
    if (complete ? chunk.nextOffset !== undefined : chunk.nextOffset !== end || !chunk.data.byteLength) throw failure('ARTIFACT_RESPONSE_INVALID');
}

function sameReference(actual: ExecutionArtifactReference, expected: ExecutionArtifactReference): boolean {
    return !!actual && (['kind', 'sessionId', 'taskId', 'artifactId'] as const).every(key => actual[key] === expected[key]);
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
