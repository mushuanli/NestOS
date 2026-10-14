import { mergeExecutionMode } from '../session/execution-mode-policy';
import { DEFAULT_SESSION_SETTINGS, type ChatSessionSettings } from '../contracts';
import type { ConversationManifest } from './types';

/** Older conversations with history retain their saved mode on upgrade. */
export function sessionSettings(raw: string | null | undefined, manifest: ConversationManifest): ChatSessionSettings {
    const saved = JSON.parse(raw ?? '{}') as Partial<ChatSessionSettings>;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid Session settings');
    return { ...DEFAULT_SESSION_SETTINGS, ...saved,
        executionModeLocked: saved.executionModeLocked === true || (saved.executionModeLocked === undefined && !!manifest.rootRoundId && !manifest.flow) };
}

/** Run inside the settings transaction so stale preferences cannot undo admission. */
export function mergeSessionSettings(current: ChatSessionSettings, patch: Partial<ChatSessionSettings>): ChatSessionSettings {
    return { ...current, ...patch, ...mergeExecutionMode(current, patch),
        version: '1.0', updatedAt: new Date().toISOString() };
}
