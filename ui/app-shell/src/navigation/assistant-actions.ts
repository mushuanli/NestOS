import {ACTION_ICONS, t} from '@itookit/common';
import type {ContextMenuBuilder, MenuItem} from '@itookit/ui-common-adapter';
import type {AssistantShortcut} from './assistant-shortcuts';

export const ASSISTANT_ADD_EVENT = 'nestos:assistant-add-shortcut';
export type ShortcutRequest = Omit<AssistantShortcut, 'id'>;
/** Navigation owns the target; the application menu owns validation and persistence. */
export function requestAssistantShortcut(item: ShortcutRequest): void {
    document.dispatchEvent(new CustomEvent(ASSISTANT_ADD_EVENT, {detail: item}));
}
export function assistantShortcutAction<T extends object>(item: ShortcutRequest): MenuItem<T> {
    return {id: 'assistant-add-shortcut', label: t('assistant.addToShortcuts'), iconHTML: ACTION_ICONS.favorite,
        onClick: () => requestAssistantShortcut(item)};
}
export function withAssistantShortcut<T extends object>(build: ContextMenuBuilder<T>, target: (item: T) => ShortcutRequest): ContextMenuBuilder<T> {
    return (item, defaults) => [...build(item, defaults), assistantShortcutAction<T>(target(item))];
}
