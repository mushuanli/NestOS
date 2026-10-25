import type {BinaryAssetReference} from '@itookit/tools/contracts';
import {artifactError, pointer, record} from './artifact-reference';

export interface ArtifactCandidate {path: string; outputName: string; value: unknown; type?: string;}
const artifactTypes = new Set(['final-answer', 'summary', 'file', 'json', 'text', 'control']);

/** Only documented output envelopes and typed binary references become file entries. */
export function* artifactCandidates(output: unknown): Generator<ArtifactCandidate> {
    const budget = {remaining: 20000};
    yield* outputCandidates(output, '', 'result', budget, 0);
}

function* outputCandidates(value: unknown, path: string, name: string, budget: {remaining: number}, depth: number): Generator<ArtifactCandidate> {
    tick(budget, depth);
    const body = record(value), outputs = record(body?.outputs), nodes = record(body?.nodes);
    if (outputs) {
        for (const [key, item] of Object.entries(outputs)) yield* candidate(item, pointer(pointer(path, 'outputs'), key), key, budget, depth + 1);
    } else if (nodes) {
        yield {path, outputName: name, value};
        for (const [key, item] of Object.entries(nodes)) yield* outputCandidates(item, pointer(pointer(path, 'nodes'), key), `${name}/${key}`, budget, depth + 1);
    } else yield* candidate(value, path, name, budget, depth + 1);
}

function* candidate(value: unknown, path: string, outputName: string, budget: {remaining: number}, depth: number): Generator<ArtifactCandidate> {
    const artifact = record(value);
    const typed = typeof artifact?.outputName === 'string' && typeof artifact.type === 'string'
        && artifactTypes.has(artifact.type) && Object.hasOwn(artifact, 'content');
    const selected = typed ? artifact.content : value, selectedPath = typed ? pointer(path, 'content') : path;
    yield {path: selectedPath, outputName, value: selected, ...(typed ? {type: artifact.type as string} : {})};
    if (!binaryReference(selected)) yield* nestedBinaries(selected, selectedPath, outputName, budget, depth + 1);
}

function* nestedBinaries(value: unknown, path: string, name: string, budget: {remaining: number}, depth: number): Generator<ArtifactCandidate> {
    tick(budget, depth);
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
        tick(budget, depth + 1);
        const child = pointer(path, key);
        if (binaryReference(item)) yield {path: child, outputName: `${name}/${key}`, value: item};
        else yield* nestedBinaries(item, child, `${name}/${key}`, budget, depth + 1);
    }
}

export function binaryReference(value: unknown): BinaryAssetReference | undefined {
    const ref = record(value);
    if (!validBinaryMetadata(ref)) return undefined;
    if (ref.kind === 'input' && typeof ref.id === 'string') return ref as unknown as BinaryAssetReference;
    if (ref.kind !== undefined) return undefined;
    return ['sessionId', 'taskId', 'owner', 'name'].every(key => typeof ref[key] === 'string') ? ref as unknown as BinaryAssetReference : undefined;
}

function validBinaryMetadata(ref: Record<string, unknown> | undefined): ref is Record<string, unknown> {
    return !!ref && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)
        && Number.isSafeInteger(ref.bytes) && (ref.bytes as number) >= 0 && typeof ref.mimeType === 'string';
}

function tick(budget: {remaining: number}, depth: number): void {
    if (--budget.remaining < 0 || depth > 48) throw artifactError('ARTIFACT_CATALOG_LIMIT', 'Artifact output exceeds catalog traversal limits');
}
