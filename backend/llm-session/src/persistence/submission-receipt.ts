import type { SessionSubmission } from '@itookit/llm-flow/contracts';
import type { Round } from '../contracts';
import type { ISessionRepository } from './types';

type SubmissionReader = Pick<ISessionRepository, 'readDocument' | 'getManifest'>;
/** A round body alone is insufficient: its history index must also be committed. */
export async function hasCommittedSubmission(reader: SubmissionReader, sessionId: string, submission: SessionSubmission): Promise<boolean> {
    const raw = await reader.readDocument(sessionId, `round-${submission.id}.json`);
    if (!raw) return false;
    const round = JSON.parse(raw) as Round;
    if (round.id !== submission.id || round.sessionId !== sessionId || !round.executions?.length) return false;
    const actual = round.submission ?? legacySubmission(round);
    if (actual?.id !== submission.id || actual.source.kind !== submission.source.kind
        || actual.source.ownerId !== submission.source.ownerId || actual.source.id !== submission.source.id) return false;
    const manifest = await reader.getManifest(sessionId);
    return manifest.rootRoundId === submission.id || Object.values(manifest.branches).includes(submission.id)
        || Object.values(manifest.children).some(ids => ids.includes(submission.id));
}
/** Compatibility decoding only; legacy origin never drives conversation policy. */
function legacySubmission(round: Round): SessionSubmission | undefined {
    const legacy = (round as Round & { projectDraft?: { projectId: string; draftId: string; submissionId: string } }).projectDraft;
    return legacy ? { id: legacy.submissionId, source: { kind: 'project-draft', ownerId: legacy.projectId, id: legacy.draftId } } : undefined;
}
