import type {ReviewJob} from './item-operation-types';
import type {KanbanService} from '@itookit/kanban/contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import type {KanbanWorkLog} from './work-log';
/** Work-log identities include the operation and changed state; healthy inspections produce no rows. */
export function itemOperationReporter(context: {journal: KanbanAutomationJournal; workLog: KanbanWorkLog; service: KanbanService}) {
    return async (job: ReviewJob): Promise<void> => {
        const stage = job.phase === 'prepared' ? 'prepared' : job.state, key = 'review-activity:' + job.id + ':' + stage + ':' + (job.code ?? '');
        if (await context.journal.get(key)) return;
        await context.workLog.append(context.service, job.boardId, job.itemId, {stage: 'review.' + stage, dispatchId: job.id,
            result: job.state === 'failed' || job.state === 'unknown' ? 'failure' : 'success', code: job.code, fields: {action: job.action},
            references: job.sessionId ? [{system: 'nestos-execution-session', id: job.sessionId, revision: job.id}] : []});
        await context.journal.update(key, old => old ?? true);
    };
}
