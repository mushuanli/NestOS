import type {ConversationSnapshot} from '../contracts';
import {createModuleLogger, randomUUID} from '@itookit/common';


const log = createModuleLogger('native-observation');

/** Bound streaming diagnostics; retain failures without recording message content. */
export function nativeObservationDiagnostics(conversationId: string) {
    const reported = new Map<string, number>();
    return (stage: string, state: ConversationSnapshot, action: () => void,
        presentation?: {revision: number; viewId: string; mounted: boolean; renderedMessageCount: number}): void => {
        const started = Date.now(), operationId = randomUUID();
        let succeeded = false;
        try {action(); succeeded = true;}
        finally {
            if (!succeeded || started - (reported.get(stage) ?? 0) >= 5_000) {
                reported.set(stage, started);
                try {const fields = {operationId, conversationId, sessionId: state.sessionId, stage,
                    result: succeeded ? 'success' : 'failure', code: succeeded ? undefined : 'NATIVE_PROJECTION_FAILED',
                    turnId: state.observation?.activeTurnId, observedAt: state.observation?.observedAt,
                    execution: state.observation?.execution, messageCount: state.messages.length,
                    historyRevision: state.observation?.historyRevision,
                    activityPhase: state.observation?.activity?.phase, activityAt: state.observation?.activity?.updatedAt,
                    textLength: state.messages.reduce((size, message) => size + message.text.length, 0),
                    queueRevision: state.instructionQueue?.revision, durationMs: Date.now() - started, ...presentation,
                    visibility: typeof document === 'undefined' ? undefined : document.visibilityState};
                    if (succeeded) log.info('chat.native.pipeline', fields); else log.warn('chat.native.pipeline', fields);
                } catch { /* Diagnostics cannot alter observation. */ }
            }
        }
    };
}
