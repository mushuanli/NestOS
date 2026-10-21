import {expect, it} from 'vitest';
import {t} from '@itookit/common';
import {localSessionStatus} from '../src/projects/local-session-status';
import {RemoteSessionStatusView} from '../src/projects/remote-session-status';
import {harnessObservation} from '@itookit/app-contracts';
import type {VFSNodeUI} from '@itookit/vfs-ui';

const activity = (approval = 2, input = 1) => ({sessionId: 's', sessionStatus: 'open', revision: 1, asOfSequence: 8,
    counts: {running: 1, queued: 0, created: 0, waiting: 3, paused: 0, blocked: 0, succeeded: 0, failed: 0, cancelled: 0}, pending: {approval, input}});

it('shows concurrent pending approvals, input and running work without collapsing them into one boolean', () => {
    const state = localSessionStatus(activity())!;
    expect(state.text).toBe([t('session.activity.approval', {count: 2}), t('session.activity.input', {count: 1}), t('session.activity.running', {count: 1})].join(' · '));
    expect(state.attention).toBe(state.text); expect(localSessionStatus(activity(1, 0))!.text).toContain(t('session.activity.approval', {count: 1}));
});

it('removes attention after all questions settle, preserves pause and displays read failures explicitly', () => {
    const state = activity(0, 0); state.counts.running = 0; state.counts.waiting = 0;
    expect(localSessionStatus(state)?.attention).toBeUndefined();
    state.counts.paused = 2; expect(localSessionStatus(state)?.text).toBe(t('session.activity.paused', {count: 2}));
    expect(localSessionStatus({unknown: true})?.text).toBe(t('session.activity.unknown')); expect(localSessionStatus(undefined)).toBeUndefined();
});

it('projects both loaded tree children and aliased recent Session rows through public presentation fields', async () => {
    const child = {id: '/s', metadata: {custom: {sessionActivity: activity()}}, presentation: {badges: []}} as unknown as VFSNodeUI;
    const parent = {id: '/', metadata: {custom: {}}, children: [child]} as unknown as VFSNodeUI;
    const view = new RemoteSessionStatusView(harnessObservation, undefined, () => {}, () => {});
    try {
        const rows = view.items([parent]); expect(rows[0]?.children?.[0]?.presentation?.subtitle).toBe(localSessionStatus(activity())?.text);
        expect(rows[0]?.children?.[0]?.presentation?.attention).toBeTruthy();
        child.metadata.custom.sessionActivity = activity(0, 0);
        expect(view.items([child])[0]?.presentation?.attention).toBeUndefined();
    } finally {await view.destroy();}
});
