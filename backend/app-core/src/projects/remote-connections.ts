import { FSError, normalizeVirtualPath } from '@itookit/vfs-core';

export interface RemoteFileSystemConfig {
    id: string; name: string; endpoint: string; username?: string; credentialRef: string; serverId?: string; projects?: boolean;
}
export type RemoteFileSystemInput = Pick<RemoteFileSystemConfig, 'name' | 'endpoint' | 'username'>;

export function normalizeConnection(input: RemoteFileSystemInput): RemoteFileSystemInput {
    // Stored catalogs and dialog input both arrive as untrusted shapes: reject them as FSError,
    // never as a TypeError from reading a property of undefined.
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const username = typeof input?.username === 'string' ? input.username.trim() : '';
    const address = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
    if (!name || (input?.username !== undefined && (!username || /[:\r\n]/.test(username)))) throw new FSError('EINVAL', 'Invalid connection name or username');
    if (!address) throw new FSError('EINVAL', 'Invalid remote endpoint');
    let endpoint: URL;
    try { endpoint = new URL(address.includes('://') ? address : `http://${address}`); }
    catch { throw new FSError('EINVAL', 'Invalid remote endpoint'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw new FSError('EINVAL', 'Invalid remote endpoint');
    return { name, ...(username ? {username} : {}), endpoint: endpoint.href.replace(/\/+$/, '') };
}

/** The first component names a server export, never a physical host directory. */
export function remoteProjectPath(path: string): { alias: string; root: string } {
    if (typeof path !== 'string' || !path.startsWith('/') || /[\\\0]/.test(path) || path.split('/').includes('..')) throw new FSError('EINVAL', 'Invalid remote project path');
    const normalized = normalizeVirtualPath(path);
    const [alias, ...parts] = normalized.slice(1).split('/');
    if (!/^[a-zA-Z0-9_-]+$/.test(alias)) throw new FSError('EINVAL', 'Export alias required');
    return { alias, root: parts.length ? '/' + parts.join('/') : '/' };
}
