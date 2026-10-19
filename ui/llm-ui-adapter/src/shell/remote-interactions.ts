import type {ConversationRequest} from '@itookit/ui-common';
import {createInteractionCard, type InteractionCard} from '@itookit/llm-ui';
import {getLocale} from '@itookit/common';
import {nativeInteraction, nativeResponse} from '../native-interactions';

type Respond = (id: string | number, response: Record<string, unknown>) => Promise<void>;
const cards = new WeakMap<HTMLElement, Map<string, {encoded: string; card: InteractionCard}>>();
/** Stable cards preserve unfinished answers while observations and permissions change. */
export function renderConversationRequests(container: HTMLElement, requests: ConversationRequest[], respond: Respond, allowed: boolean): void {
    const current = cards.get(container) ?? new Map(); cards.set(container, current);
    const alive = new Set<string>();
    for (const request of requests) {
        const view = nativeInteraction(request), key = view.id;
        const encoded = JSON.stringify({...request, responding: undefined}); alive.add(key);
        let row = current.get(key);
        if (row?.encoded !== encoded) {
            row?.card.destroy();
            row = {encoded, card: createInteractionCard({...view, responding: false}, async response => {await respond(request.id, nativeResponse(response));}, {locale: getLocale()})};
            current.set(key, row);
        }
        row.card.setPending(!allowed || !!request.responding);
        container.append(row.card.element);
    }
    for (const [key, row] of current) if (!alive.has(key)) {row.card.destroy(); current.delete(key);}
}
export function clearConversationRequests(container: HTMLElement): void {
    for (const row of cards.get(container)?.values() ?? []) row.card.destroy();
    cards.delete(container);
}
