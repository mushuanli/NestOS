import {t} from '@itookit/common';
import type {SessionActivity} from '@itookit/durable-kernel/contracts';

/** Presentation only: Session lifecycle and individual Task states remain distinct. */
export function localSessionStatus(raw: unknown): {text: string; attention?: string} | undefined {
    if (!raw || typeof raw !== 'object') return;
    if ('unknown' in raw) return {text: t('session.activity.unknown')};
    const activity = raw as SessionActivity;
    if (!activity.counts || !activity.pending) return;
    const parts: string[] = [];
    const add = (key: Parameters<typeof t>[0], count: number) => { if (Number.isSafeInteger(count) && count > 0) parts.push(t(key, {count})); };
    add('session.activity.approval', activity.pending.approval);
    add('session.activity.input', activity.pending.input);
    add('session.activity.cleanup', activity.pending.cleanup);
    for (const phase of ['blocked', 'running', 'queued', 'created', 'paused'] as const) {
        add(`session.activity.${phase}`, activity.counts[phase]);
    }
    if (!parts.length) add('session.activity.waiting', activity.counts.waiting);
    const attention = needsAttention(activity);
    const text = parts.join(' · ') || idleText(activity);
    return {text, ...(attention ? {attention: text} : {})};
}

function needsAttention(activity: SessionActivity): boolean {
    return activity.pending.approval + activity.pending.input > 0 || activity.counts.blocked > 0;
}

function idleText(activity: SessionActivity): string {
    if (activity.sessionStatus !== 'open') return t(`session.activity.${activity.sessionStatus}`);
    return activity.latestExit ? t(`session.activity.${activity.latestExit.status}`) : '';
}
