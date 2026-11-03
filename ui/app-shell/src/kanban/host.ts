import {ACTION_ICONS, CHAT_ICONS, t, createModuleLogger} from '@itookit/common';
import type {KanbanPresentation, KanbanUIOptions} from '@itookit/kanban/ui';
const log = createModuleLogger('kanban');
export const kanbanPresentation: KanbanPresentation = {
    text: (key, values) => t(`kanban.${key}` as Parameters<typeof t>[0], values),
    icons: {refreshView: ACTION_ICONS.refreshView, more: CHAT_ICONS.more, close: ACTION_ICONS.close, back: ACTION_ICONS.back, copy: CHAT_ICONS.copy},
    referenceUrl: path => `${location.href.split('#')[0]}#/kanban/${encodeURIComponent(path)}`,
    log: event => {if (event.result === 'failure') log.warn('kanban.ui', event); else log.debug('kanban.ui', event);},
};
/** Product deployment guidance is supplied to the portable view through a semantic port. */
export const kanbanReviewGuidance: NonNullable<KanbanUIOptions['reviewGuidance']> = (board, item) => {
    if (!item.externalRefs?.some(ref => ref.system === 'nestos-worktree') && board.automation?.preparation?.id !== 'git-worktree') return;
    return {title: t('kanban.developmentReview.title'), paragraphs: [
        t('kanban.developmentReview.pending'), t('kanban.developmentReview.switch'), t('kanban.developmentReview.verify'),
        t('kanban.developmentReview.accept'), t('kanban.developmentReview.reject'), t('kanban.developmentReview.cleanup'),
    ]};
};
