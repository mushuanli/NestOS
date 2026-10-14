// @file: llm-ui/components/common/ScrollController.ts

import { TimerManager } from './TimerManager';

export interface ScrollControllerCallbacks {
    onUserScrolledUp?: () => void;
    onUserScrolledDown?: () => void;
    onScroll?: () => void;
}

/**
 * 统一滚动控制器
 *
 * 职责：
 * - 自动滚动判断（shouldAutoScroll）
 * - 用户滚动状态跟踪（isUserScrolledUp）
 * - 内容高度变化响应
 * - 区分程序滚动 vs 用户滚动
 *
 * 设计原则：
 * - 不依赖 StreamRenderPipeline 的内部状态（SRP）
 * - Pipeline 只调用 handleContentResize()，本类自行决定是否滚动
 * - handleContentResize() 保证单次 layout read + 单次 write
 */
export class ScrollController {
    private shouldAutoScroll = true;
    private _isStreamingMode = false;
    private _isUserScrolledUp = false;
    private lastScrollHeight = 0;
    private scrollLockUntil = 0;

    private scrollFrameId: number | null = null;
    private timers = new TimerManager();

    private readonly SCROLL_THRESHOLD = 150;

    // 程序滚动标记
    private isProgrammaticScroll = false;
    private programmaticScrollTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly PROGRAMMATIC_SCROLL_WINDOW = 300; // 缩短到 200ms

    private callbacks: ScrollControllerCallbacks;

    constructor(
        private container: HTMLElement,
        callbacks?: ScrollControllerCallbacks
    ) {
        this.callbacks = callbacks || {};
        this.container.addEventListener('scroll', this.handleScroll, { passive: true });
    }

    get isStreamingMode(): boolean {
        return this._isStreamingMode;
    }

    get isUserScrolledUp(): boolean {
        return this._isUserScrolledUp;
    }

    // ================================================================
    // 滚动事件处理
    // ================================================================

    private handleScroll = (): void => {
        // 程序触发的滚动：不更新用户状态
        if (this.isProgrammaticScroll) return;

        const { scrollTop, scrollHeight, clientHeight } = this.container;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

        const wasScrolledUp = this._isUserScrolledUp;
        const isNearBottom = distanceFromBottom < this.SCROLL_THRESHOLD;

        this._isUserScrolledUp = !isNearBottom;

        // Transition callbacks fire before the lock guard so state
        // transitions are never lost, even during scrollLockUntil.
        if (!wasScrolledUp && this._isUserScrolledUp) {
            this.callbacks.onUserScrolledUp?.();
        } else if (wasScrolledUp && !this._isUserScrolledUp) {
            this.callbacks.onUserScrolledDown?.();
        }

        if (this._isStreamingMode) {
            this.shouldAutoScroll = !this._isUserScrolledUp;
        } else {
            if (Date.now() < this.scrollLockUntil) return;
            this.shouldAutoScroll = isNearBottom;
        }

        this.callbacks.onScroll?.();
    };

    // ================================================================
    // 内容高度变化
    // ================================================================

    /**
     * 由 StreamRenderPipeline（流式）或 ContentResizeTracker（非流式）调用
     *
     * 流式期间：Pipeline 已在 RAF 内调用，直接写入 scrollTop，无额外节流
     * 非流式期间：保持原有节流逻辑
     */
    handleContentResize(): void {
        if (!this.shouldAutoScroll) return;

        // 单次 read
        const scrollHeight = this.container.scrollHeight;
        const clientHeight = this.container.clientHeight;
        const targetTop = scrollHeight - clientHeight;

        // 没有变化 → 跳过
        if (scrollHeight === this.lastScrollHeight) return;
        this.lastScrollHeight = scrollHeight;

        // 已经在底部 → 跳过
        if (Math.abs(this.container.scrollTop - targetTop) < 2) return;

        // 单次 write
        this.markProgrammaticScroll();
        this.container.scrollTop = targetTop;
    }

    // ================================================================
    // 滚动操作
    // ================================================================

    forceScrollToTop(): void {
        this.shouldAutoScroll = false;
        this._isUserScrolledUp = false;
        this.markProgrammaticScroll();
        if (this.scrollFrameId !== null) cancelAnimationFrame(this.scrollFrameId);
        this.scrollFrameId = this.timers.requestAnimationFrame(() => {
            this.scrollFrameId = null;
            this.container.scrollTop = 0;
            this.lastScrollHeight = this.container.scrollHeight;
            this.scrollLockUntil = Date.now() + 100;
        });
    }

    scrollToBottom(force: boolean = false): void {
        if (!force && !this.shouldAutoScroll) return;
        if (force && this._isStreamingMode && this._isUserScrolledUp) return;

        if (this.scrollFrameId !== null) {
            cancelAnimationFrame(this.scrollFrameId);
        }

        this.markProgrammaticScroll();

        this.scrollFrameId = this.timers.requestAnimationFrame(() => {
            this.scrollFrameId = null;
            this.container.scrollTop = this.container.scrollHeight;
            this.lastScrollHeight = this.container.scrollHeight;
            this.scrollLockUntil = Date.now() + 100;
        });
    }

    forceScrollToBottom(): void {
        this.shouldAutoScroll = true;
        this._isUserScrolledUp = false;

        this.markProgrammaticScroll();

        if (this.scrollFrameId !== null) {
            cancelAnimationFrame(this.scrollFrameId);
        }

        this.scrollFrameId = this.timers.requestAnimationFrame(() => {
            this.scrollFrameId = null;
            this.container.scrollTop = this.container.scrollHeight;
            this.lastScrollHeight = this.container.scrollHeight;
            this.scrollLockUntil = Date.now() + 100;
        });
    }

    private markProgrammaticScroll(): void {
        this.isProgrammaticScroll = true;

        if (this.programmaticScrollTimer !== null) {
            this.timers.clearTimeout(this.programmaticScrollTimer);
        }

        this.programmaticScrollTimer = this.timers.setTimeout(() => {
            this.isProgrammaticScroll = false;
            this.programmaticScrollTimer = null;
        }, this.PROGRAMMATIC_SCROLL_WINDOW);
    }

    // ================================================================
    // 流式模式
    // ================================================================

    enterStreamingMode(): void {
        if (this._isStreamingMode) return;

        // Flush any pending scroll-to-bottom frame from the previous
        // exit cycle BEFORE reading the scroll position. Otherwise a
        // deferred RAF from forceScrollToBottom / scrollToBottom can
        // race with enterStreamingMode, causing stale scrollTop to be
        // misread as "user scrolled up" and the "New response available"
        // indicator to appear incorrectly.
        if (this.scrollFrameId !== null) {
            cancelAnimationFrame(this.scrollFrameId);
            this.scrollFrameId = null;
            this.container.scrollTop = this.container.scrollHeight;
            this.lastScrollHeight = this.container.scrollHeight;
        }

        this._isStreamingMode = true;

        const { scrollTop, scrollHeight, clientHeight } = this.container;
        const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
        const isNearBottom = distanceFromBottom < this.SCROLL_THRESHOLD;

        this.shouldAutoScroll = isNearBottom;
        this._isUserScrolledUp = !isNearBottom;
        this.lastScrollHeight = this.container.scrollHeight;
    }

    exitStreamingMode(): void {
        if (!this._isStreamingMode) return;
        this._isStreamingMode = false;
    }

    destroy(): void {
        this.container.removeEventListener('scroll', this.handleScroll);

        if (this.scrollFrameId !== null) {
            cancelAnimationFrame(this.scrollFrameId);
            this.scrollFrameId = null;
        }

        this.timers.destroy();
    }
}
