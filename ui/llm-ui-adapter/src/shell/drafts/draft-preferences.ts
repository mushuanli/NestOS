import {isImageResizePolicy} from '@itookit/kernel-adapters/contracts';
import type {SessionDraftPreferences} from '@itookit/ui-common';
import type {ChatInputSettings, IChatInputConfig} from '../../domain/ports/IChatInputPresenter';
import type {ConnectionOption, ExecutorOption} from '../../domain/types';

const portableSettings = ['executionMode', 'historyLength', 'temperature', 'streamMode', 'thinkingEnabled',
    'reasoningEffort', 'webSearchEnabled', 'systemPromptAppend'] as const;

/** Copy choices, never source text, files, execution locks or project-bound Flow references. */
export function inheritDraftPreferences(current: IChatInputConfig, preferences: SessionDraftPreferences,
    agents: readonly ExecutorOption[], connections: readonly ConnectionOption[], remote = false): IChatInputConfig {
    const next = {...current, settings: {...current.settings}};
    if (agents.some(agent => agent.id === preferences.agentId)) next.agentId = preferences.agentId!;
    if (preferences.settings && Object.hasOwn(preferences.settings, 'imageResize')) {
        const resize = preferences.settings.imageResize;
        if (resize === undefined || isImageResizePolicy(resize)) next.settings.imageResize = resize;
    }
    if (remote || preferences.agentId?.startsWith('remote:') || !preferences.settings) return next;
    const source = preferences.settings;
    Object.assign(next.settings, Object.fromEntries(portableSettings.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]])));
    Object.assign(next.settings, inheritConnection(current.settings, source, connections));
    return next;
}

function inheritConnection(current: ChatInputSettings, source: Readonly<Record<string, unknown>>,
    connections: readonly ConnectionOption[]): ChatInputSettings {
    if (!Object.hasOwn(source, 'connectionId') && !Object.hasOwn(source, 'modelTier')) return {};
    const connectionId = Object.hasOwn(source, 'connectionId') ? source.connectionId : current.connectionId;
    const connection = connections.find(item => connectionId ? item.id === connectionId : item.isDefault);
    if (!connection || connection.enabled === false || !(connection.credentialsReady ?? connection.hasApiKey)) return {};
    const tier = [source.modelTier ?? 'auto', current.modelTier, 'auto'].find(candidate => hasModel(connection, candidate));
    if (!tier) return {};
    return {connectionId: connection.id === connectionId ? connection.id : undefined, modelTier: tier as ChatInputSettings['modelTier']};
}

function hasModel(connection: ConnectionOption, tier: unknown): boolean {
    if (typeof tier !== 'string' || !['auto', 'optimal', 'standard', 'fast'].includes(tier)) return false;
    const key = tier === 'auto' ? 'optimal' : tier as 'optimal' | 'standard' | 'fast';
    if (connection.resolvedTiers) return Boolean(connection.resolvedTiers[key]);
    return Boolean(connection.tiers?.[key] ?? connection.tiers?.optimal);
}
