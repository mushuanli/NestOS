import type {Kernel, TaskRecord} from '@itookit/durable-kernel';
import {sha256Hex} from '@itookit/llm-context';
import {randomUUID} from '@itookit/common';
import type {Artifact} from '@itookit/llm-flow/contracts';
import type {TaskAssetReader} from '@itookit/tools/contracts';
import type {SessionLogger} from '@itookit/llm-session';
import type {ExecutionArtifactDescriptor, ExecutionArtifactPage, ExecutionArtifactScope, ListExecutionArtifacts,
    ReadExecutionArtifact, ExecutionArtifactChunk} from '@itookit/app-contracts';
import {artifactCandidates, binaryReference, type ArtifactCandidate} from './artifact-catalog';
import {artifactError, artifactId, parseArtifactId} from './artifact-reference';

const maxChunkBytes = 1024 * 1024;

/** Read committed output and existing Task assets. No catalog, Task or receipt is written. */
export class TaskArtifacts {
    constructor(private readonly kernel: Kernel, private readonly readAsset: TaskAssetReader, private readonly logger: SessionLogger) {}

    list(input: ListExecutionArtifacts): Promise<ExecutionArtifactPage> {
        return this.trace('list', input, input?.operationId, async () => {
            const task = await this.task(input), offset = pageNumber(input.offset, 0, 20000), limit = pageNumber(input.limit, 20, 100, 1);
            const items: ExecutionArtifactDescriptor[] = [], seen = new Set<string>(); let index = 0, more = false;
            for (const candidate of this.candidates(task)) {
                if (seen.has(candidate.path)) continue; seen.add(candidate.path);
                if (index++ < offset) continue;
                if (items.length === limit) {more = true; break;}
                items.push(await this.describe(task, candidate));
            }
            return {...scope(task), items, ...(more ? {nextOffset: offset + items.length} : {})};
        });
    }

    read(input: ReadExecutionArtifact): Promise<ExecutionArtifactChunk> {
        return this.trace('read', {sessionId: input?.reference?.sessionId}, input?.operationId, async operationId => {
            const reference = input?.reference;
            if (reference?.kind !== 'task-output') throw artifactError('ARTIFACT_REFERENCE_INVALID', 'Invalid artifact kind');
            if (parseArtifactId(reference.artifactId).taskId !== reference.taskId) throw artifactError('ARTIFACT_SCOPE_INVALID', 'Artifact reference Task identity does not match its scope');
            const {task, candidate, descriptor} = await this.resolve(reference.sessionId, reference.artifactId);
            const offset = pageNumber(input.offset, 0, Number.MAX_SAFE_INTEGER), limit = pageNumber(input.limit, 256 * 1024, maxChunkBytes, 1);
            if (descriptor.bytes !== undefined && offset > descriptor.bytes) throw artifactError('ARTIFACT_RANGE_INVALID', 'Artifact offset exceeds content length');
            const bytes = await this.bytes(task, candidate, operationId);
            if (offset > bytes.length) throw artifactError('ARTIFACT_RANGE_INVALID', 'Artifact offset exceeds content length');
            const end = Math.min(bytes.length, offset + limit), digest = await sha256Hex(bytes);
            if (digest !== descriptor.sha256 || bytes.length !== descriptor.bytes) throw artifactError('ARTIFACT_INTEGRITY', 'Artifact content does not match the committed output');
            return {reference: descriptor.reference, offset, totalBytes: bytes.length, sha256: digest, mimeType: descriptor.mimeType,
                data: new Uint8Array(bytes.subarray(offset, end)).buffer, ...(end < bytes.length ? {nextOffset: end} : {})};
        });
    }

    context(sessionId: string, id: string): Promise<Artifact> {
        return this.trace('context', {sessionId}, undefined, async () => {
            const {task, candidate, descriptor} = await this.resolve(sessionId, id);
            if (descriptor.kind !== 'text' && descriptor.kind !== 'json') throw artifactError('ARTIFACT_CONTEXT_UNSUPPORTED', 'Convert binary or remote files explicitly before adding them to context');
            return {id: descriptor.reference.artifactId, nodeRunId: task.id, outputName: descriptor.outputName,
                type: descriptor.kind, content: candidate.value as Artifact['content'],
                contentHash: await sha256Hex(typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.value)), createdAt: task.updatedAt};
        });
    }

    private async resolve(sessionId: string, id: string) {
        const parsed = parseArtifactId(id), task = await this.task({sessionId, taskId: parsed.taskId});
        for (const candidate of this.candidates(task)) {
            if (candidate.path !== parsed.path) continue;
            const descriptor = await this.describe(task, candidate);
            if (descriptor.reference.artifactId !== id) throw artifactError('ARTIFACT_CHANGED', 'Artifact reference does not match the committed output');
            return {task, candidate, descriptor};
        }
        throw artifactError('ARTIFACT_NOT_FOUND', 'Artifact is not present in the selected Task output');
    }

    private async task(input: ExecutionArtifactScope): Promise<TaskRecord> {
        if (!input || !validId(input.sessionId) || !validId(input.taskId)) throw artifactError('ARTIFACT_SCOPE_INVALID', 'Explicit Session and Task identities are required');
        const task = await this.kernel.task(input.sessionId, input.taskId);
        if (task.sessionId !== input.sessionId || task.id !== input.taskId) throw artifactError('ARTIFACT_SCOPE_INVALID', 'Artifact Task ownership mismatch');
        if (!['succeeded', 'failed', 'cancelled'].includes(task.status)) throw artifactError('ARTIFACT_OUTPUT_PENDING', 'Task output is not committed yet');
        return task;
    }

    private *candidates(task: TaskRecord): Generator<ArtifactCandidate> {
        if (task.output !== undefined) yield* artifactCandidates(task.output);
    }

    private async describe(task: TaskRecord, candidate: ArtifactCandidate): Promise<ExecutionArtifactDescriptor> {
        const value = candidate.value, binary = binaryReference(value), encoded = encode(value, candidate.type);
        const kind = artifactKind(candidate);
        const digest = await sha256Hex(JSON.stringify([candidate.type ?? null, value]));
        return {reference: {kind: 'task-output', sessionId: task.sessionId, taskId: task.id, artifactId: artifactId(task.id, candidate.path, digest)},
            taskId: task.id, ...(task.labels?.invocationId ? {invocationId: task.labels.invocationId} : {}),
            outputName: candidate.outputName, kind, name: fileName(candidate.outputName, kind),
            mimeType: binary?.mimeType ?? (kind === 'text' ? 'text/plain' : 'application/json'),
            ...(kind === 'unavailable' ? {unavailableReason: 'ARTIFACT_FILE_NOT_IMPORTED'} : {
                bytes: binary?.bytes ?? encoded.length, sha256: binary?.sha256 ?? await sha256Hex(encoded)}),
        };
    }

    private async bytes(task: TaskRecord, candidate: ArtifactCandidate, operationId: string): Promise<Uint8Array> {
        const binary = binaryReference(candidate.value);
        if (binary) {
            try {return await this.readAsset(binary, {sessionId: task.sessionId, taskId: task.id, operationId, effectId: 'artifact-read'});}
            catch (error) {throw binaryReadError(error);}
        }
        if (candidate.type === 'file') throw artifactError('ARTIFACT_FILE_NOT_IMPORTED', 'The output file has not been imported into host asset storage');
        return encode(candidate.value, candidate.type);
    }

    private async trace<T>(stage: string, input: Partial<ExecutionArtifactScope>, supplied: string | undefined, action: (operationId: string) => Promise<T>): Promise<T> {
        const operationId = supplied && /^[\w-]{1,128}$/.test(supplied) ? supplied : randomUUID(), started = Date.now();
        const fields = {operation: 'execution.artifacts', stage, sessionId: input?.sessionId, taskId: input?.taskId, operationId};
        try {
            const result = await action(operationId);
            this.logger.debug('Execution artifact read completed', {...fields, outcome: 'success', durationMs: Date.now() - started}); return result;
        } catch (error) {
            this.logger.warn('Execution artifact read failed', {...fields, outcome: 'failure', code: safeCode(error),
                causeCode: (error as {causeCode?: string})?.causeCode, storageCode: (error as {storageCode?: string})?.storageCode,
                durationMs: Date.now() - started}); throw error;
        }
    }
}

function encode(value: unknown, type?: string): Uint8Array {
    const text = typeof value === 'string' && type !== 'json' ? value : JSON.stringify(value);
    if (text === undefined) throw artifactError('ARTIFACT_OUTPUT_INVALID', 'Artifact output cannot be serialized');
    return new TextEncoder().encode(text);
}
function artifactKind(candidate: ArtifactCandidate): ExecutionArtifactDescriptor['kind'] {
    if (binaryReference(candidate.value)) return 'binary';
    if (candidate.type === 'file') return 'unavailable';
    return typeof candidate.value === 'string' && candidate.type !== 'json' ? 'text' : 'json';
}
function validId(value: unknown): value is string {return typeof value === 'string' && !!value.trim() && value.length <= 1024;}
function scope(task: TaskRecord): ExecutionArtifactScope {return {sessionId: task.sessionId, taskId: task.id};}
function pageNumber(value: unknown, fallback: number, maximum: number, minimum = 0): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw artifactError('ARTIFACT_RANGE_INVALID', 'Invalid artifact page or read range');
    return value as number;
}
function fileName(name: string, kind: string): string {
    return `${name.replace(/[\/\\\x00-\x1f]/g, '_').slice(0, 180) || 'result'}${kind === 'text' ? '.txt' : kind === 'json' ? '.json' : ''}`;
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'ARTIFACT_READ_FAILED';
}

function binaryReadError(error: unknown): Error {
    const causeCode = safeCode(error);
    const supplied = (error as {storageCode?: unknown})?.storageCode;
    const storageCode = typeof supplied === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(supplied) ? supplied : undefined;
    if (storageCode === 'EACCES' || storageCode === 'EPERM')
        return Object.assign(artifactError('ARTIFACT_STORAGE_DENIED', 'Artifact storage is not readable by this host'), {causeCode, storageCode});
    if (['ASSET_SESSION_MISMATCH', 'ASSET_FLOW_MISMATCH', 'ASSET_INPUT_NOT_SELECTED', 'MEDIA_ASSET_IDENTITY'].includes(causeCode))
        return Object.assign(artifactError('ARTIFACT_BINARY_SCOPE_DENIED', 'Artifact bytes are not authorized for this execution'), {causeCode});
    if (causeCode === 'MEDIA_ASSET_INTEGRITY' || causeCode === 'INPUT_ASSET_INTEGRITY')
        return Object.assign(artifactError('ARTIFACT_BINARY_INTEGRITY', 'Artifact bytes do not match their committed identity'), {causeCode});
    return Object.assign(artifactError('ARTIFACT_BINARY_UNAVAILABLE', 'Artifact bytes are missing or cannot be read'), {causeCode, storageCode});
}
