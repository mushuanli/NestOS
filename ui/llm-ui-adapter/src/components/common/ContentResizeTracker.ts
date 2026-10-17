// @file: llm-ui/components/common/ContentResizeTracker.ts

import { TimerManager } from './TimerManager';

/**
 * 内容高度变化追踪器
 *
 * 核心改动：
 * - 新增 suspend/resume 方法
 * - 流式期间完全静默，避免与 StreamController 冲突
 */
export class ContentResizeTracker {
    private resizeObserver: ResizeObserver;
    private pendingCallback = false;
    private lastNotifiedHeight = 0;
    private timers = new TimerManager();
    private rafId: number | null = null;
    private isSuspended = false;

    constructor(
        private container: HTMLElement,
        private onResize: (newHeight: number, oldHeight: number) => void
    ) {
        this.lastNotifiedHeight = container.scrollHeight;
        this.resizeObserver = new ResizeObserver(this.handleObserverEntry);
        this.resizeObserver.observe(container);
    }

    /**
     * 暂停监听（流式期间由 StreamController 接管）
     */
    suspend(): void {
        this.isSuspended = true;
    }

    /**
     * 恢复监听
     */
    resume(): void {
        this.isSuspended = false;
        this.lastNotifiedHeight = this.container.scrollHeight;
    }

    private handleObserverEntry = (): void => {
        if (this.isSuspended) return;
        if (this.pendingCallback) return;

        this.pendingCallback = true;
        this.scheduleCheck();
    };

    private scheduleCheck(): void {
        if (this.rafId !== null) return;

        this.rafId = this.timers.requestAnimationFrame(() => {
            this.rafId = null;
            this.pendingCallback = false;
            this.checkHeight();
        });
    }

    private checkHeight(): void {
        const currentHeight = this.container.scrollHeight;
        if (currentHeight !== this.lastNotifiedHeight) {
            const oldHeight = this.lastNotifiedHeight;
            this.lastNotifiedHeight = currentHeight;
            this.onResize(currentHeight, oldHeight);
        }
    }

    destroy(): void {
        this.resizeObserver.disconnect();
        this.timers.destroy();
    }
}
