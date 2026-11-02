import {ACTION_ICONS, CHAT_ICONS, t, createModuleLogger} from '@itookit/common';
import type {KanbanPresentation} from '@itookit/kanban/ui';
const log = createModuleLogger('kanban');
export const kanbanPresentation: KanbanPresentation = {
    text: (key, values) => t(`kanban.${key}` as Parameters<typeof t>[0], values),
    icons: {refreshView: ACTION_ICONS.refreshView, more: CHAT_ICONS.more, close: ACTION_ICONS.close, back: ACTION_ICONS.back},
    referenceUrl: path => `${location.href.split('#')[0]}#/kanban/${encodeURIComponent(path)}`,
    log: event => {if (event.result === 'failure') log.warn('kanban.ui', event); else log.debug('kanban.ui', event);},
};
