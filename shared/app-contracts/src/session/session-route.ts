import { FSError } from '@itookit/vfs-core';

/** Query syntax is reserved only on a Session identity, never on file paths. */
export function parseSessionRoute(resource: string): { path: string; branch?: string } {
    const match = /^\/?((?:folder:[^/?]+\/)*[a-zA-Z0-9_-]+)\?(.*)$/.exec(resource);
    if (!match) return { path: resource.startsWith('/') ? resource : '/' + resource };
    const query = new URLSearchParams(match[2]);
    const branch = query.get('branch');
    if (!branch || /[\u0000-\u001f]/.test(branch) || query.getAll('branch').length !== 1
        || [...query.keys()].some(key => key !== 'branch')) throw new FSError('EINVAL', 'Invalid Session branch route');
    return { path: '/' + match[1], branch };
}

export function sessionRoute(sessionId: string, branch: string): string {
    return `${sessionId}?branch=${encodeURIComponent(branch)}`;
}
