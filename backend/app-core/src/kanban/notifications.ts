import {sha256HexSync} from '@itookit/common';
import type {SeqEventJournal} from '@itookit/vfs-core';
import type {ApplicationEventFact} from '@itookit/app-contracts/services';
import type {KanbanBoard, KanbanEvent, KanbanService} from '@itookit/app-contracts';
import {requireValue} from './rules';
import {escalationReasons} from './reducer';
import {terminal} from './planning';

export interface KanbanNotifications {
    /** Stable identity of the authorized store/project, including the remote authority when applicable. */
    sourceId: string;
    journal: Pick<SeqEventJournal<ApplicationEventFact>, 'transaction'>;
}
const retained = new Set(['create-item', 'plan-item', 'set-stage', 'publish-proposal', 'claim', 'accept-transfer', 'request-transfer',
    'submit', 'review', 'escalated', 'apply-discovery', 'cancel-item', 'close-plan', 'archive-items', 'items.archived', 'restore-item', 'block-item', 'unblock-item', 'link-reference', 'release-item', 'review-amendment', 'append-record', 'review-record', 'link-record']);

/** Source fact publication and its checkpoint commit together in the authenticated system journal. */
export async function projectKanbanEvents(target: KanbanNotifications, source: KanbanService, boardId: string, now = Date.now()): Promise<void> {
    requireValue(typeof target.sourceId === 'string' && target.sourceId.length > 0 && target.sourceId.length <= 512, 'INVALID_NOTIFICATION_SOURCE');
    const key = `kanban/${sha256HexSync(JSON.stringify([target.sourceId, boardId]))}`;
    for (let batch = 0; batch < 10; batch++) {
        const raw = await target.journal.transaction(tx => tx.getState(key)), after = raw === null ? 0 : Number(raw);
        requireValue((raw === null || /^\d+$/.test(raw)) && Number.isSafeInteger(after) && after >= 0, 'INVALID_NOTIFICATION_CHECKPOINT');
        const page = await source.events(boardId, after, 200);
        if (!page.length) return;
        const board = await source.read(boardId);
        let previous = after;
        for (const event of page) {requireValue(event.boardId === boardId && Number.isSafeInteger(event.sequence) && event.sequence === previous + 1, 'INVALID_NOTIFICATION_EVENTS'); previous = event.sequence;}
        await target.journal.transaction(async tx => {
            if (await tx.getState(key) !== raw) return;
            for (const event of page) {
                const fact = project(event, board, target.sourceId, now);
                if (fact) await tx.append(`${key}/${event.sequence}`, fact, event.at);
            }
            await tx.setState(key, String(previous));
        });
        if (page.length < 200) return;
    }
}
function project(event: KanbanEvent, board: KanbanBoard, sourceId: string, now: number): ApplicationEventFact | undefined {
    const rule = board.notifications?.rules?.[`${event.kind}.${event.data.reason ?? ''}`] ?? board.notifications?.rules?.[event.kind];
    if (!retained.has(event.kind) && !rule) return undefined;
    if (event.kind === 'apply-discovery' && !event.data.itemIds?.length && !event.data.recordIds?.length) return undefined;
    const reason = event.kind === 'escalated' && /^[a-z][a-z0-9-]{0,79}$/.test(event.data.reason ?? '') ? `.${event.data.reason}` : '';
    const level = rule === 'none' ? undefined : rule ?? defaultLevel(event);
    const notification = relevant(event, board, now) ? level : undefined;
    return {type: `kanban.${event.kind}${reason}`, resourceId: `kanban:${JSON.stringify([sourceId, board.id, event.itemId ?? event.data.recordId ?? null])}`,
        operationId: event.operationId, sourceSequence: event.sequence, ...(notification ? {notification} : {})};
}
function defaultLevel(event: KanbanEvent): 'info' | 'error' | undefined {
    if (event.kind === 'escalated') return 'error';
    if (event.kind === 'append-record' && event.data.reason === 'decision-draft') return 'info';
    if (event.kind === 'apply-discovery' && (['amendment-proposed', 'proposal-created'].includes(event.data.reason ?? '') || event.data.recordIds?.length)) return 'info';
    if (['submit', 'request-transfer', 'publish-proposal'].includes(event.kind)) return 'info';
    return undefined;
}
function relevant(event: KanbanEvent, board: KanbanBoard, now: number): boolean {
    const item = board.items.find(i => i.id === event.itemId);
    if (event.kind === 'escalated') return !!item && !terminal(item) && (event.data.reason === 'transfer-timeout'
        ? !item.transfer && item.status === 'claimed' : escalationReasons(board, item, now).includes(event.data.reason ?? ''));
    if (event.kind === 'submit') return item?.status === 'review';
    if (event.kind === 'request-transfer') return !!item?.transfer && item.transfer.expiresAt > now;
    if (event.kind === 'publish-proposal') return item?.status === 'open';
    return true;
}
