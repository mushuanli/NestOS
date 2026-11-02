import type {CallTargetCatalog, CallTargetChoice} from '@itookit/llm-ui';
import type {ExecutorOption} from '../../domain/types';
import {t} from '@itookit/common';

/** Native execution remains available beside published NestOS prompt targets. */
export function remotePromptTargets(catalog: CallTargetCatalog, executors: readonly ExecutorOption[]): CallTargetCatalog {
    const native: CallTargetChoice[] = executors.filter(item => item.id.startsWith('remote:')).map(item => ({
        id: item.id, target: {kind: 'agent', id: item.id, version: 'native', digest: item.id}, label: `${t('harness.nativePrompt')} · ${item.name}`,
        icon: item.icon, group: t('harness.remoteAgents'),
    }));
    return {...catalog, label: t('harness.promptTarget'), entries: [...native, ...catalog.entries], ...(native.length ? {error: undefined} : {})};
}

export function draftHarnessTarget(executorId: string | undefined, selection?: Readonly<Record<string, string>>, catalog?: import('../../contracts').ConversationModelCatalog) {
    if (!executorId?.startsWith('remote:')) throw Object.assign(new Error(t('harness.executorRequired')), {code: 'REMOTE_HARNESS_REQUIRED'});
    let identity: unknown;
    try {identity = JSON.parse(decodeURIComponent(executorId.slice(7)));} catch {throw Object.assign(new Error(t('harness.executorInvalid')), {code: 'REMOTE_HARNESS_INVALID'});}
    if (!Array.isArray(identity) || identity.length !== 3 || identity.some(item => typeof item !== 'string' || !item))
        throw Object.assign(new Error(t('harness.executorInvalid')), {code: 'REMOTE_HARNESS_INVALID'});
    const current = catalog?.current ?? catalog?.default;
    const modelId = selection?.modelId ?? current?.modelId ?? catalog?.models[0]?.id;
    const reasoningEffort = selection?.reasoningEffort ?? (current?.modelId === modelId ? current?.reasoningEffort : undefined);
    return {profileId: identity[2] as string, expectedProject: {nodeConnectionId: identity[0] as string, serverProjectId: identity[1] as string}, ...(modelId ? {selection: {modelId, ...(reasoningEffort ? {reasoningEffort} : {})}} : {})};
}
