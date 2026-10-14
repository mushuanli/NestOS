import { generateUUID } from '@itookit/common';
import { FSError } from '@itookit/vfs-core';
import type { ProjectDraftRecord } from './contracts';

export const emptyDraft = (): ProjectDraftRecord => ({ version: 1, id: generateUUID(), state: 'draft', data: '' });
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);

/** Validate at the storage boundary; the legacy shape had no version or draft identity. */
export function decodeDraftRecord(raw: string | null): { record: ProjectDraftRecord; migrated: boolean } {
    if (raw === null) return { record: emptyDraft(), migrated: true };
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw invalid(); }
    if (!value || typeof value !== 'object') throw invalid();
    const saved = value as Record<string, unknown>;
    if (typeof saved.data !== 'string' || saved.version !== undefined && saved.version !== 1) throw invalid();
    if (saved.id !== undefined && !identity(saved.id) || saved.sessionId !== undefined && !identity(saved.sessionId)
        || saved.submissionId !== undefined && !identity(saved.submissionId) || saved.title !== undefined && typeof saved.title !== 'string') throw invalid();
    if (saved.submissionId && !saved.sessionId) throw invalid();
    const state = saved.sessionId ? 'submitting' : 'draft';
    if (saved.state !== undefined && saved.state !== state) throw invalid();
    return { migrated: saved.version !== 1 || saved.id === undefined, record: { version: 1, id: saved.id as string ?? generateUUID(), state, data: saved.data,
        ...(saved.sessionId ? { sessionId: saved.sessionId as string, title: saved.title as string | undefined,
            submissionId: saved.submissionId as string | undefined } : {}) } };
}
function invalid() { return new FSError('EINVAL', 'Invalid project draft record'); }
