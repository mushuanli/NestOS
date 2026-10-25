export function artifactError(code: string, message: string): Error {return Object.assign(new Error(message), {code});}

export function artifactId(taskId: string, path: string, digest: string): string {
    return `task-output/v1/${encodeURIComponent(taskId)}/${encodeURIComponent(path)}/${digest}`;
}

export function parseArtifactId(id: unknown): {taskId: string; path: string; digest: string} {
    if (typeof id !== 'string' || id.length > 16000) throw artifactError('ARTIFACT_REFERENCE_INVALID', 'Invalid artifact reference');
    const parts = id.split('/');
    if (!validParts(parts))
        throw artifactError('ARTIFACT_REFERENCE_INVALID', 'Invalid artifact reference');
    try {
        const taskId = decodeURIComponent(parts[2]), path = decodeURIComponent(parts[3]);
        if (!validSelection(taskId, path)) throw new Error();
        return {taskId, path, digest: parts[4]};
    } catch {throw artifactError('ARTIFACT_REFERENCE_INVALID', 'Invalid artifact reference');}
}

function validParts(parts: string[]): boolean {
    return parts.length === 5 && parts[0] === 'task-output' && parts[1] === 'v1' && /^[a-f0-9]{64}$/.test(parts[4]);
}
function validSelection(taskId: string, path: string): boolean {
    return !!taskId && taskId.length <= 1024 && path.length <= 4096 && (!path || path.startsWith('/'));
}

export function pointer(parent: string, key: string): string {return `${parent}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;}

export function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
