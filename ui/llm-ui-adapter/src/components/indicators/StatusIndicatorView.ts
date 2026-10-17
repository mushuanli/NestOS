// @file: llm-ui/components/indicators/StatusIndicatorView.ts

import { t } from '@itookit/common';
import type { IStatusPresenter } from '../../domain/ports/IStatusPresenter';
import type { SessionSnapshot } from '@itookit/llm-session/contracts';
import type { DOMCache } from '../common';

interface StatusInfo {
    cls: string;
    text: string;
    loading: boolean;
}

const STATUS_MAP: Record<string, StatusInfo> = {
    running: { cls: '--running', text: 'Generating...', loading: true },
    queued: { cls: '--queued', text: 'Queued', loading: true },
    completed: { cls: '--completed', text: 'Ready', loading: false },
    failed: { cls: '--failed', text: 'Error', loading: false },
};

const DEFAULT_STATUS: StatusInfo = { cls: '--idle', text: 'Ready', loading: false };

/**
 * 实现 IStatusPresenter
 *
 * 内部 DOM 操作对 Shell 完全不可见。
 */
export class StatusIndicatorView implements IStatusPresenter {
    private statusDot: HTMLElement | null = null;
    private statusText: HTMLElement | null = null;

    constructor(
        private domCache: DOMCache,
        /** Synchronous getter for isGenerating — avoids async dependency on CommandBus. */
        private isGenerating: () => boolean,
        private onLoadingChange: (loading: boolean) => void
    ) { }

    cacheElements(): void {
        const indicator = this.domCache.byId('llm-status-indicator');
        if (indicator) {
            this.statusDot = indicator.querySelector('.llm-workspace-status__dot');
            this.statusText = indicator.querySelector('.llm-workspace-status__text');
        }
    }

    update(status: string, text?: string): void {
        if (!this.statusDot || !this.statusText) {
            this.cacheElements();
            if (!this.statusDot || !this.statusText) return;
        }

        this.statusDot.className = 'llm-workspace-status__dot';
        const info = STATUS_MAP[status] || DEFAULT_STATUS;

        this.statusDot.classList.add(info.cls);
        this.statusText.textContent = text ?? (status === 'aborted' ? t('session.execution.cancelled') : info.text);
        this.onLoadingChange(info.loading);
    }

    updateFromSnapshot(snapshot: SessionSnapshot): void {
        this.update(snapshot.status);
        if (snapshot.isRunning) this.onLoadingChange(true);
    }

    updateBackground(payload: { running: number; queued: number }): void {
        const el = this.domCache.byId('llm-bg-indicator');
        if (!el) return;

        const isCurrentGen = this.isGenerating();
        const otherRunning = isCurrentGen ? Math.max(0, payload.running - 1) : payload.running;
        const total = otherRunning + payload.queued;

        if (total > 0) {
            el.style.display = 'flex';
            const badge = el.querySelector('.llm-bg-badge');
            if (badge) badge.textContent = `${total} background task${total > 1 ? 's' : ''}`;
        } else {
            el.style.display = 'none';
        }
    }

    destroy(): void {
        this.statusDot = null;
        this.statusText = null;
    }
}
