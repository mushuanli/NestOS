import {getLocale, t} from '@itookit/common';
import type {Run} from './session-output';

const statuses: Record<string, Parameters<typeof t>[0]> = {
    created: 'flow.invoke.created', ready: 'flow.invoke.ready', blocked: 'flow.invoke.blocked',
    running: 'flow.invoke.running', waiting: 'flow.invoke.waiting', succeeded: 'flow.invoke.succeeded',
    failed: 'flow.invoke.failed', cancelled: 'flow.invoke.cancelled',
};
export function runStatus(status: string): string {return statuses[status] ? t(statuses[status]) : status;}
export function runTitle(run: Run): string {
    const nodes = run.name.split(' → ');
    const name = nodes.length > 1 ? t('flow.runs.nodesTitle', {name: nodes[0], count: nodes.length}) : run.name;
    return name.length > 64 ? name.slice(0, 61) + '…' : name;
}
export function runIdentity(run: Run): string {
    const date = run.createdAt ? new Date(run.createdAt).toLocaleString(getLocale(), {hour12: false}) : t('flow.runs.unknownTime');
    return `${date} · #${run.taskId.slice(-8)}`;
}
export function runLabel(run: Run): string {return `${runTitle(run)} · ${runIdentity(run)} · ${runStatus(run.status)}`;}
