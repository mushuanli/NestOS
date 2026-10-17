import { expect, it, vi } from 'vitest';
import type { SessionSubmission } from '@itookit/llm-flow/contracts';
import type { ConversationManifest } from '../src/contracts';
import { hasCommittedSubmission } from '../src/persistence/submission-receipt';

const submission: SessionSubmission = { id: 'op', source: { kind: 'conversation', ownerId: 'session', id: 'op' } };
function fixture() {
    const round = { id: 'op', sessionId: 'session', submission: structuredClone(submission), executions: [{ taskId: 'task' }] };
    const manifest = { rootRoundId: null, branches: {}, children: {} } as ConversationManifest;
    const reader = { readDocument: vi.fn(async () => JSON.stringify(round)), getManifest: vi.fn(async () => manifest) };
    return { round, manifest, reader };
}

it('requires a committed history index in addition to the round and its execution', async () => {
    const host = fixture();
    expect(await hasCommittedSubmission(host.reader, 'session', submission)).toBe(false);
    host.manifest.children = { parent: ['op'] };
    expect(await hasCommittedSubmission(host.reader, 'session', submission)).toBe(true);
});

it.each(['id', 'sessionId', 'execution', 'sourceKind', 'ownerId', 'sourceId'] as const)('rejects mismatched %s evidence', async field => {
    const host = fixture(); host.manifest.rootRoundId = 'op';
    if (field === 'id') host.round.id = 'other';
    if (field === 'sessionId') host.round.sessionId = 'other';
    if (field === 'execution') host.round.executions = [];
    if (field === 'sourceKind') host.round.submission = { ...submission, source: { kind: 'project-draft', ownerId: 'session', id: 'op' } };
    if (field === 'ownerId') host.round.submission.source.ownerId = 'other';
    if (field === 'sourceId') host.round.submission.source.id = 'other';
    expect(await hasCommittedSubmission(host.reader, 'session', submission)).toBe(false);
});
