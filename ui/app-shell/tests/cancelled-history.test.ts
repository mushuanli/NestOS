// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { t } from '@itookit/common';
import { HistoryView } from '../../llm-ui/src/components/HistoryView';
import { SessionEventHandler } from '../../llm-ui/src/shell/SessionEventHandler';
import { StatusIndicatorView } from '../../llm-ui/src/components/indicators/StatusIndicatorView';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it.each(['ABORTED', 'TIMEOUT', undefined])('renders %s without guessing cancellation from the message', code => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const host = document.createElement('div'); document.body.append(host);
    host.scrollTo = vi.fn();
    const view = new HistoryView(host, {});
    const status = vi.fn();
    const handler = new SessionEventHandler({ historyView: view, statusIndicator: { update: status } } as never);
    try {
        handler.handleSessionEvent({ type: 'error', payload: { error: { code, message: '<img src=x> Fetch aborted' } } } as never);
        const bubble = host.querySelector<HTMLElement>('[data-outcome]')!;
        expect(bubble.dataset.outcome).toBe(code === 'ABORTED' ? 'cancelled' : 'failed');
        expect(bubble.querySelector('strong')?.textContent).toBe(t(code === 'ABORTED' ? 'session.execution.cancelled' : 'session.execution.failed'));
        expect(bubble.querySelector('[data-action="retry-last"]')?.textContent?.trim()).toBe(t(code === 'ABORTED' ? 'session.execution.runAgain' : 'session.execution.retry'));
        expect(bubble.textContent).toContain('<img src=x> Fetch aborted');
        expect(bubble.querySelector('img')).toBeNull();
        expect(status).toHaveBeenCalledWith(code === 'ABORTED' ? 'aborted' : 'failed');
    } finally { view.destroy(); }
});

it('shows cancellation as a terminal neutral status with loading stopped', () => {
    const indicator = document.createElement('div');
    indicator.innerHTML = '<span class="llm-workspace-status__dot"></span><span class="llm-workspace-status__text"></span>';
    const loading = vi.fn();
    const view = new StatusIndicatorView({ byId: () => indicator } as never, () => false, loading);
    view.update('aborted');
    expect(indicator.textContent).toBe(t('session.execution.cancelled'));
    expect(indicator.querySelector('.llm-workspace-status__dot')?.className).not.toContain('--failed');
    expect(loading).toHaveBeenLastCalledWith(false);
    view.destroy();
});
