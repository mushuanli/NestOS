import type {Kernel} from '@itookit/durable-kernel';
import type {SessionActivity} from '@itookit/durable-kernel/contracts';
import type {ISessionRepository} from '@itookit/llm-session';
import type {KanbanSessionPhase} from '@itookit/kanban/contracts';
import {KanbanError} from '@itookit/kanban';
import type {KanbanSessionSource} from '@itookit/kanban/activity';
/** Cold Session metadata only; never resumes, attaches, or exposes Task records. */
export function createLocalKanbanSessionSource(repository: Pick<ISessionRepository,'getManifest'>, kernel: Pick<Kernel,'sessionActivity'>,resource?:(sessionId:string,branch:string)=>Promise<string|undefined>): KanbanSessionSource {
    return {async authorizeBinding(_board,sessionId) {await sessionManifest(repository,sessionId);},async inspect(_board,sessionId) {
        const manifest=await sessionManifest(repository,sessionId), activity=await kernel.sessionActivity(sessionId);
        if(activity.sessionId!==sessionId) throw new KanbanError('SESSION_ACTIVITY_SCOPE_MISMATCH');
        const lastActivityAt=activity.lastActivityAt ?? activity.latestExit?.at;
        const resourceId=await resource?.(sessionId,manifest.currentBranch);
        return {sessionId,...(resourceId?{resourceId}:{}),title:manifest.title,createdAt:manifest.createdAt,state:sessionPhase(activity),lastActivityAt,observedAt:Date.now(),stale:false};
    }};
}
async function sessionManifest(repository:Pick<ISessionRepository,'getManifest'>,sessionId:string) {
    try {return await repository.getManifest(sessionId);}
    catch(error) {if((error as {code?:string})?.code==='ENOENT') throw new KanbanError('SESSION_NOT_FOUND');throw error;}
}
export function sessionPhase(activity: SessionActivity): KanbanSessionPhase {
    const {counts,pending}=activity;
    if(counts.running) return 'running';
    if(pending.approval) return 'waiting-approval';
    if(pending.input) return 'waiting-input';
    if(counts.blocked||pending.cleanup) return 'unknown';
    if(counts.paused||['suspended','suspending'].includes(activity.sessionStatus)) return 'paused';
    if(counts.queued||counts.created) return 'queued';
    if(counts.waiting) return 'waiting';
    return activity.latestExit ? ({succeeded:'completed',failed:'failed',cancelled:'cancelled'} as const)[activity.latestExit.status] : 'idle';
}
