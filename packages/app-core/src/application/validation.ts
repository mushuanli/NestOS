import { FSError } from '@itookit/vfs-core';
import type { ApplicationQueries, ApplicationCommands } from './contracts';

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FSError('EINVAL', 'Expected application input');
    return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): asserts value is string {
    if (typeof value !== 'string' || !value.length || value.length > max || /[\0\r\n]/.test(value)) throw new FSError('EINVAL', 'Invalid application value');
}
function session(value: unknown): void {
    text(value); if (!/^[a-zA-Z0-9._:-]+$/.test(value)) throw new FSError('EINVAL', 'Invalid Session identity');
}
function workspace(value: unknown): void {
    const identity = record(value);
    if (identity.kind === 'workspace') { text(identity.name, 80); return; }
    if (identity.kind === 'project') { session(identity.id); return; }
    throw new FSError('EINVAL', 'Invalid workspace identity');
}
function folder(value: unknown): void {
    if (value === undefined || value === null) return;
    text(value, 4096);
    if (!value.startsWith('/') || value.split('/').some(part => part === '.' || part === '..') || value.includes('\\'))
        throw new FSError('EINVAL', 'Invalid Session folder');
}
export function validateApplicationQuery(name: keyof ApplicationQueries, input: unknown): void {
    if (name === 'capabilities') return;
    const value = record(input);
    switch (name) {
        case 'entry': case 'directory': case 'file':
            workspace(value.workspace); text(value.path, 4096);
            if (name === 'file' && value.encoding !== undefined && !['text', 'base64'].includes(String(value.encoding))) throw new FSError('EINVAL', 'Invalid content encoding');
            return;
        case 'navigation': case 'sessions': folder(value.folder); return;
        case 'receipt': session(value.requestId); return;
        case 'session': case 'conversation': session(value.sessionId); if (value.before !== undefined) text(value.before); return;
        default: throw new FSError('ECAPABILITY', 'Unknown application query');
    }
}
export function validateApplicationCommand(name: keyof ApplicationCommands, input: unknown): void {
    const value = record(input);
    switch (name) {
        case 'createConversation': text(value.title); folder(value.folder); return;
        case 'conversation': session(value.sessionId); text(value.name, 100); if (value.args !== undefined) assertDurableValue(value.args); return;
        case 'respond': session(value.sessionId); session(value.taskId); text(value.interactionId); assertDurableValue(value.value); return;
        case 'cancelTask': session(value.sessionId); session(value.taskId); return;
        case 'saveFile':
            workspace(value.workspace); text(value.path, 4096);
            if (typeof value.content !== 'string') throw new FSError('EINVAL', 'Expected text content');
            if (value.revision !== undefined) text(value.revision, 1000);
            return;
        default: throw new FSError('ECAPABILITY', 'Unknown application command');
    }
}

function assertDurableValue(value: unknown, depth = 0): void {
    if (depth > 100) throw new FSError('EINVAL', 'Application input is too deeply nested');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
        throw new FSError('EINVAL', 'Application input must be JSON data');
    for (const item of Object.values(value)) assertDurableValue(item, depth + 1);
}
