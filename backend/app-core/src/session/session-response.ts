import {RoundLog} from '@itookit/llm-session';
import {assistantResponseText, type ISessionRepository, type Round} from '@itookit/llm-session/contracts';
import {createModuleLogger, randomUUID} from '@itookit/common';
import type {SessionResponse, SessionResponseQuery} from '@itookit/app-contracts/services';

/** A cold read of the selected response; it never binds, switches branches or executes. */
export async function sessionResponse(repository: ISessionRepository, sessionId: string, query: SessionResponseQuery = {}): Promise<SessionResponse | undefined> {
    const operationId = randomUUID(), started = Date.now(), log = createModuleLogger('session-response');
    try {
        if (query.operationId !== undefined && (typeof query.operationId !== 'string' || !query.operationId.trim())
            || query.roundId !== undefined && (typeof query.roundId !== 'string' || !query.roundId.trim()) || query.operationId && query.roundId)
            throw Object.assign(new Error('Invalid response selector'), {code: 'SESSION_RESPONSE_SELECTOR_INVALID'});
        const round = await selectedRound(repository, sessionId, query);
        const response = round ? {roundId: round.id, operationId: round.submission?.id, status: round.status, text: assistantResponseText(round), finishReason: round.result?.finishReason} : undefined;
        log.debug('session.response', {operationId, sessionId, stage: 'read', result: round ? 'found' : 'missing', status: round?.status, durationMs: Date.now() - started});
        return response;
    } catch (error) {
        const code = (error as {code?: string})?.code;
        log.warn('session.response', {operationId, sessionId, stage: 'read', result: 'failure', code: code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'SESSION_RESPONSE_READ_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
async function selectedRound(repository: ISessionRepository, sessionId: string, query: SessionResponseQuery): Promise<Round | undefined> {
    const log = new RoundLog(repository, sessionId), manifest = await log.loadManifest(), branch = query.branch ?? manifest.currentBranch;
    if (typeof branch !== 'string' || branch !== manifest.currentBranch && !Object.hasOwn(manifest.branches, branch)) return undefined;
    let id = branch === manifest.currentBranch ? manifest.currentHead : manifest.branches[branch];
    const visited = new Set<string>();
    while (id && !visited.has(id)) {
        visited.add(id); const round = await log.readRound(id, branch, manifest);
        if (!round) return undefined;
        if (!round._deleted && (!query.operationId || round.submission?.id === query.operationId) && (!query.roundId || round.id === query.roundId)) return round;
        id = round.historyParentIds[0];
    }
    return undefined;
}
