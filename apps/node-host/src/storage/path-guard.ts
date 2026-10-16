import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { FSError } from '@itookit/vfs-core';

export class PathGuard {
    constructor(private readonly root: string) {}
    visible(value: string): boolean {
        return !['/_meta', '/__vfs_namespace_journal__'].some(root => value === root || value.startsWith(`${root}/`));
    }
    async check(value: unknown): Promise<string> {
        if (typeof value !== 'string' || !value.startsWith('/') || /[\x00-\x1f\\]/.test(value)
            || !this.visible(value)
            || value.split('/').slice(1).some(part => part === '..' || part === '.' || (!part && value !== '/'))) {
            throw new FSError('EINVAL', 'Expected a canonical VFS path');
        }
        let current = this.root;
        for (const part of value.split('/').filter(Boolean)) {
            current = path.join(current, part);
            try { if ((await lstat(current)).isSymbolicLink()) throw new FSError('EACCES', 'Symbolic links are unavailable over HTTP'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
        }
        return value;
    }
}
