import { traceBoot } from '@itookit/common';
import type { SessionManager } from '@itookit/llm-session';
import type { ProjectDraftService } from '../projects/drafts/service';

/** Wire notifications and drain in-flight recovery before runtime storage is released. */
export async function attachProjectDraftRecovery(drafts: ProjectDraftService,
    sessions: Pick<SessionManager, 'onGlobalEvent'>, recoverInitially = true): Promise<() => Promise<void>> {
    const pending = new Set<Promise<void>>();
    const unsubscribe = sessions.onGlobalEvent(event => {
        if (event.type !== 'execution_task_projected') return;
        const work = drafts.submitted(event.payload).catch(error => console.warn('Draft recovery deferred', error));
        pending.add(work); void work.finally(() => pending.delete(work));
    });
    if (recoverInitially) {
        const recovery = traceBoot('projects.drafts.recover (background)', () => drafts.recover());
        pending.add(recovery);
        void recovery.catch(error => console.warn('[Boot] Draft recovery deferred', error));
    }
    return async () => { unsubscribe(); await Promise.allSettled(pending); };
}
