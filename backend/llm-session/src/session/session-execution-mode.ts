import type { ISessionRepository } from '../persistence/types';
import type { TaskInput } from '../core/types';
import { directExecutionMode, snapshotTaskInput } from './direct-execution-mode';
import { t, type SessionTextKey } from '../utils/host-ports';
import { assertExecutionMode } from './execution-mode-policy';

/** Resolve the persistent session policy before constructing a new direct task. */
export async function resolveSessionExecutionMode(engine: Pick<ISessionRepository, 'getSessionSettings'>, input: TaskInput, translate: (key: SessionTextKey) => string = t): Promise<TaskInput> {
    if (input.sendIntent?.execution.kind === 'flow' || input.overrides?.flowId) return input;
    const settings = await engine.getSessionSettings(input.sessionId);
    const requested = directExecutionMode(input);
    if (!settings.executionModeLocked) return input;
    const mode = settings.executionMode ?? 'chat';
    assertExecutionMode(settings, requested, translate);
    return snapshotTaskInput({ ...input, overrides: { ...input.overrides, executionMode: mode } });
}
