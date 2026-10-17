// @file: llm-ui/components/common/TimerManager.ts

/**
 * 定时器生命周期管理器
 *
 * 追踪所有 setTimeout / setInterval / requestAnimationFrame / requestIdleCallback，
 * destroy 时统一清理，防止组件销毁后定时器仍触发回调。
 *
 * 用法：
 *   const timers = new TimerManager();
 *   timers.setTimeout(() => { ... }, 1000);
 *   timers.destroy(); // 一次性清理所有
 */
export class TimerManager {
    private timeouts = new Set<ReturnType<typeof setTimeout>>();
    private intervals = new Set<ReturnType<typeof setInterval>>();
    private rafs = new Set<number>();
    private idleCallbacks = new Set<number>();
    private isDestroyed = false;

    setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
        if (this.isDestroyed) return 0 as any;

        const id = setTimeout(() => {
            this.timeouts.delete(id);
            if (!this.isDestroyed) {
                callback();
            }
        }, delay);

        this.timeouts.add(id);
        return id;
    }

    setInterval(callback: () => void, interval: number): ReturnType<typeof setInterval> {
        if (this.isDestroyed) return 0 as any;

        const id = setInterval(() => {
            if (this.isDestroyed) {
                clearInterval(id);
                this.intervals.delete(id);
                return;
            }
            callback();
        }, interval);

        this.intervals.add(id);
        return id;
    }

    requestAnimationFrame(callback: FrameRequestCallback): number {
        if (this.isDestroyed) return 0;

        const id = requestAnimationFrame((time) => {
            this.rafs.delete(id);
            if (!this.isDestroyed) {
                callback(time);
            }
        });

        this.rafs.add(id);
        return id;
    }

    requestIdleCallback(
        callback: IdleRequestCallback,
        options?: IdleRequestOptions
    ): number {
        if (this.isDestroyed) return 0;

        if (!('requestIdleCallback' in window)) {
            // fallback to setTimeout
            const id = this.setTimeout(() => callback({
                didTimeout: true,
                timeRemaining: () => 0,
            } as IdleDeadline), options?.timeout ?? 50);
            return id as unknown as number;
        }

        const id = window.requestIdleCallback((deadline) => {
            this.idleCallbacks.delete(id);
            if (!this.isDestroyed) {
                callback(deadline);
            }
        }, options);

        this.idleCallbacks.add(id);
        return id;
    }

    clearTimeout(id: ReturnType<typeof setTimeout>): void {
        clearTimeout(id);
        this.timeouts.delete(id);
    }

    clearInterval(id: ReturnType<typeof setInterval>): void {
        clearInterval(id);
        this.intervals.delete(id);
    }

    cancelAnimationFrame(id: number): void {
        cancelAnimationFrame(id);
        this.rafs.delete(id);
    }

    cancelIdleCallback(id: number): void {
        if ('cancelIdleCallback' in window) {
            window.cancelIdleCallback(id);
        }
        this.idleCallbacks.delete(id);
    }

    destroy(): void {
        this.isDestroyed = true;

        this.timeouts.forEach(id => clearTimeout(id));
        this.timeouts.clear();

        this.intervals.forEach(id => clearInterval(id));
        this.intervals.clear();

        this.rafs.forEach(id => cancelAnimationFrame(id));
        this.rafs.clear();

        if ('cancelIdleCallback' in window) {
            this.idleCallbacks.forEach(id => window.cancelIdleCallback(id));
        }
        this.idleCallbacks.clear();
    }
}
