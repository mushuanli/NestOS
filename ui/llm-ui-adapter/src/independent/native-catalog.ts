import {t} from '@itookit/common';
import type {ConversationSnapshot} from '@itookit/ui-common';

/** A partial command directory does not make the conversation or its read-only queries offline. */
export function nativeCatalogNotice(state: ConversationSnapshot): {code: string; message: string} | undefined {
    const observation = state.commandCatalogObservation;
    if (!observation || observation.complete) return;
    const code = observation.code && /^[A-Z][A-Z0-9_]{0,79}$/.test(observation.code) ? observation.code : 'COMMAND_CATALOG_PARTIAL';
    const pending = code === 'DSH_SESSION_NOT_ATTACHED' || code === 'DSH_SESSION_REQUIRED';
    return {code, message: pending ? t('harness.commandsRequireAttach') : t('harness.commandsPartial', {code})};
}
