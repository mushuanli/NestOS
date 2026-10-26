import {RoundLog} from '../persistence/round-log';
import type {ISessionRepository} from '../persistence/types';
import type {SubmissionRequest} from '../contracts/submission';

/** Branch at a persisted message boundary; never copy history after the selected Round. */
export async function prepareBranchSubmission(repository: ISessionRepository, supplied: SubmissionRequest): Promise<SubmissionRequest> {
    const request = structuredClone(supplied), anchor = request.branchFrom, id = request.submission?.id;
    if (!anchor || !id || !request.expectedSessionId || !request.expectedBranch || !['user', 'assistant'].includes(anchor.role)
        || !anchor.roundId || !anchor.branch || anchor.userIndex !== undefined && (!Number.isSafeInteger(anchor.userIndex) || anchor.userIndex < 0))
        throw failure('BRANCH_ANCHOR_INVALID');
    const log = new RoundLog(repository, request.expectedSessionId), manifest = await log.loadManifest();
    if (!Object.hasOwn(manifest.branches, anchor.branch)) throw failure('BRANCH_SOURCE_UNAVAILABLE');
    const source = await log.readRound(anchor.roundId, anchor.branch, manifest);
    if (!source || !await onBranch(log, manifest.branches[anchor.branch], anchor.roundId, anchor.branch)) throw failure('BRANCH_ANCHOR_UNAVAILABLE');
    if (source.status === 'pending' || source.status === 'running' || source.status === 'waiting') throw failure('BRANCH_SOURCE_RUNNING');
    const users = source.input.filter(message => message.role === 'user');
    if (anchor.userIndex !== undefined && (anchor.role !== 'user' || anchor.userIndex >= users.length)) throw failure('BRANCH_ANCHOR_INVALID');
    const prefix = anchor.role === 'user' ? users.slice(0, anchor.userIndex === undefined ? users.length : anchor.userIndex + 1) : [];
    const createdFrom = anchor.role === 'user' ? 'edit' : 'manual', metadata = manifest.branchMeta[request.expectedBranch];
    if (Object.hasOwn(manifest.branches, request.expectedBranch)) {
        if (metadata?.sourceRoundId !== anchor.roundId || metadata.forkedFromBranch !== anchor.branch || metadata.createdFrom !== createdFrom)
            throw failure('BRANCH_IDENTITY_CONFLICT');
    } else {
        // Graph helpers read copy-on-write payloads and profiles from the selected source ref.
        await repository.updateManifest(request.expectedSessionId, {currentBranch: anchor.branch, currentHead: manifest.branches[anchor.branch]});
        if (anchor.role === 'assistant') await log.branchAfterRound(anchor.roundId, request.expectedBranch);
        else await log.createBranchForReplacement(anchor.roundId, id, {branchName: request.expectedBranch, createdFrom: 'edit'});
    }
    return {...request, overrides: {...request.overrides, ...(prefix.length ? {userMessagePrefix: structuredClone(prefix)} : {})}};
}
async function onBranch(log: RoundLog, head: string | null, roundId: string, branch: string): Promise<boolean> {
    const seen = new Set<string>();
    while (head && !seen.has(head)) {if (head === roundId) return true; seen.add(head); head = (await log.readRound(head, branch))?.historyParentIds[0] ?? null;}
    return false;
}
function failure(code: string): Error {return Object.assign(new Error(code), {code});}
