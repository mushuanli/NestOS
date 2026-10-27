import { FSError } from '@itookit/vfs-core';

/** Paths are relative to the NestOS filesystem, never to the host OS root. */
export const SESSION_STORAGE_ROOT = '/var/lib/sessions';
export const KERNEL_STORAGE_ROOT = '/var/lib/kernel';

export function sessionStorageRoot(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Session storage identity');
    return `${SESSION_STORAGE_ROOT}/${sessionId}`;
}
export function sessionExecutionRoot(sessionId: string): string {
    return `${sessionStorageRoot(sessionId)}/kernel`;
}

export function storageIdentityConflict(id: string, registered: string, candidate: string): FSError {
    return Object.assign(new FSError('ECONFLICT', `Duplicate Session storage identity ${id}: registered=${registered}; candidate=${candidate}`, 'session-storage', candidate),
        { storageReason: 'SESSION_STORAGE_IDENTITY_CONFLICT', sessionId: id, registered, candidate });
}
