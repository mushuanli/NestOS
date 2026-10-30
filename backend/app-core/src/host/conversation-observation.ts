import type {SessionSnapshot, SessionManagementPort} from '@itookit/llm-session/contracts';
import type {ConversationClient, ConversationContexts} from '../runtime/conversation-contexts';

/** Mirror host-owned execution into a reader without binding or submitting another run. */
export function observeConversation<T extends ConversationClient['sessionManager']>(manager: T, observation?: Pick<ConversationContexts, 'subscribe'>): T {
    if (!observation) return manager;
    let mirrored: SessionSnapshot | undefined;
    const projected: ConversationClient['sessionManager'] & Pick<SessionManagementPort, 'getSessions' | 'getStatus' | 'isGenerating'> = {
        getSessions: () => projected.getSnapshot().sessions,
        getStatus: () => projected.getSnapshot().status,
        isGenerating: () => projected.getSnapshot().isRunning,
        getSnapshot: () => {
            const local = manager.getSnapshot();
            return mirrored && matches(local, mirrored) ? mirrored : local;
        },
        onGlobalEvent: listener => manager.onGlobalEvent(listener),
        onEvent: listener => {
            const local = manager.onEvent(event => {if (event.type !== 'instructions:changed') mirrored = undefined; listener(event);});
            const remote = observation.subscribe((id, event, snapshot) => {
                const current = manager.getSnapshot();
                if (id !== current.sessionId || !matches(current, snapshot) || !snapshot.isRunning && !mirrored) return;
                mirrored = snapshot; listener(event);
            });
            return () => {local(); remote(); mirrored = undefined;};
        },
    };
    return projectMethods(manager, projected);
}
function matches(left: SessionSnapshot, right: SessionSnapshot): boolean {
    return left.sessionId === right.sessionId && left.view?.manifest.currentBranch === right.view?.manifest.currentBranch;
}
function projectMethods<T extends object>(manager: T, projected: object): T {
    return new Proxy(manager, {get(target, key) {
        if (Object.hasOwn(projected, key)) return Reflect.get(projected, key);
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
    }});
}
