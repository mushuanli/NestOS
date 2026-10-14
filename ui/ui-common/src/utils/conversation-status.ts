import { HARNESS_STATE_ICONS, t } from '@itookit/common';
import type { ConversationSnapshot } from '../interfaces/ConversationControls';

type Observation = NonNullable<ConversationSnapshot['observation']>;
function recentActivity(observation: Observation, now: number) {
    const updatedAt = observation.updatedAt;
    if (observation.execution !== 'unknown' || observation.connection === 'offline' || observation.nativeError
        || typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || updatedAt <= 0) return;
    const recent = now >= updatedAt && now - updatedAt <= 120_000;
    return {label: recent ? t('harness.activity.recent') : t('harness.activity.updated', {time: new Date(updatedAt).toLocaleString()}),
        refreshAt: recent ? updatedAt + 120_001 : undefined};
}

export function conversationStatus(observation: Observation, now = Date.now()) {
    const activity = recentActivity(observation, now);
    const key = observation.connection === 'offline' ? 'offline' : observation.nativeError ? 'error'
        : activity ? 'unknown' : observation.stale ? 'stale' : observation.execution;
    const label = activity?.label ?? t(key === 'unknown' && observation.rawStatus === 'notLoaded' ? 'harness.state.unloaded' : `harness.state.${key}`);
    const result = observation.lastResult ? t(`harness.result.${observation.lastResult}`) : '';
    const text = [label, result, observation.receiptUnknown ? t('harness.unknown') : ''].filter(Boolean).join(' · ');
    const tooltip = [text, ...(activity ? [t('harness.activity.explanation')] : []), t(observation.canInterrupt && observation.canRespond ? 'harness.control.both' : observation.canInterrupt ? 'harness.control.interrupt' : observation.canRespond ? 'harness.control.respond' : 'harness.control.observe'),
        t('harness.observed', {source: t(`harness.source.${observation.source}`),
        time: observation.observedAt ? new Date(observation.observedAt).toLocaleString() : t('harness.state.unknown')})].join('\n');
    return {text, tooltip, icon: HARNESS_STATE_ICONS[key], refreshAt: activity?.refreshAt,
        indicator: key === 'running' ? 'running' : key === 'waiting-approval' || key === 'waiting-input' ? 'waiting' : 'idle'};
}
