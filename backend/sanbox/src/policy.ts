import { SandboxError, type SandboxCommand, type SandboxPolicy } from './types';

export function inside(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

export function invalid(message: string): never {
    throw new SandboxError('INVALID_POLICY', message);
}

export function assertPath(path: string): void {
    if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.endsWith('/') ||
        /[\x00-\x1f\x7f]/.test(path) || path.includes('//') || path.split('/').some(p => p === '.' || p === '..')) {
        invalid(`Expected a normalized absolute path: ${path}`);
    }
}

export function validatePolicy(policy: SandboxPolicy): void {
    if (policy.network !== undefined && !['deny', 'allow'].includes(policy.network)) invalid('Invalid network policy');
    const read = policy.readOnlyPaths ?? [];
    const write = policy.writablePaths ?? [];
    for (const path of [...read, ...write]) assertPath(path);
    for (const path of [...read, ...write]) {
        if (['/proc', '/dev', '/sys'].some(root => inside(path, root))) invalid(`Reserved path: ${path}`);
    }
    for (const path of write) {
        const reserved = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/System', '/Library', '/private/etc'];
        if (reserved.some(root => inside(path, root) || inside(root, path))) invalid(`Runtime path is not writable: ${path}`);
        if (['/tmp', '/private', '/private/tmp', '/var', '/private/var'].includes(path)) invalid(`Shared path is not writable: ${path}`);
        if (read.some(child => inside(child, path))) invalid(`Read-only grant overlaps writable ancestor: ${path}`);
    }
}

export function validateCommand(policy: SandboxPolicy, request: SandboxCommand): void {
    assertPath(request.cwd);
    const paths = [...policy.readOnlyPaths ?? [], ...policy.writablePaths ?? []];
    if (!paths.some(root => inside(request.cwd, root))) invalid('Working directory is outside sandbox grants');
    if (!request.command || request.command.startsWith('-') || request.command.includes('\0')) invalid('Invalid command');
    for (const arg of request.args ?? []) {
        if (typeof arg !== 'string' || arg.includes('\0')) invalid('Invalid command argument');
    }
    for (const [key, value] of Object.entries(request.env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) invalid('Invalid environment entry');
    }
}
