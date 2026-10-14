import { t, type SessionTextKey } from '../utils/host-ports';
import type { ChatExecutionMode } from '@itookit/llm-tasks/contracts';
import type { ChatSessionSettings } from '../contracts';

/** Pure session policy shared by admission and transactional preference updates. */
export function assertExecutionMode(settings: Pick<ChatSessionSettings, 'executionMode' | 'executionModeLocked'>,
    requested: ChatExecutionMode | undefined, translate: (key: SessionTextKey) => string = t): void {
    if (requested !== undefined && requested !== 'chat' && requested !== 'agent') throw new Error('Invalid chat execution mode');
    if (settings.executionModeLocked && requested !== undefined && requested !== (settings.executionMode ?? 'chat'))
        throw new Error(translate('chatInput.executionMode.locked'));
}

export function mergeExecutionMode(current: Pick<ChatSessionSettings, 'executionMode' | 'executionModeLocked'>,
    patch: Pick<Partial<ChatSessionSettings>, 'executionMode' | 'executionModeLocked'>) {
    assertExecutionMode(current, patch.executionMode);
    return { executionMode: current.executionModeLocked ? current.executionMode ?? 'chat' : patch.executionMode ?? current.executionMode,
        executionModeLocked: current.executionModeLocked === true || patch.executionModeLocked === true };
}
