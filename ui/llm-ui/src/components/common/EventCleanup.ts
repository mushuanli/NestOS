// @file: llm-ui/components/common/EventCleanup.ts

/**
 * 事件监听器生命周期管理器
 *
 * 统一收集所有 addEventListener 调用，destroy 时一次性移除。
 *
 * 用法：
 *   const events = new EventCleanup();
 *   events.add(element, 'click', handler);
 *   events.add(document, 'keydown', handler);
 *   events.cleanup(); // 移除所有
 */

interface ListenerRecord {
    target: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
    capture: boolean;
}

export class EventCleanup {
    private listeners: ListenerRecord[] = [];

    /**
     * 添加事件监听并注册清理
     */
    add(
        target: EventTarget,
        type: string,
        handler: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
    ): void {
        const capture = typeof options === 'boolean'
            ? options
            : (options as AddEventListenerOptions)?.capture ?? false;

        target.addEventListener(type, handler, options);
        this.listeners.push({ target, type, handler, capture });
    }

    /**
     * 移除所有注册的事件监听器
     */
    cleanup(): void {
        for (const { target, type, handler, capture } of this.listeners) {
            target.removeEventListener(type, handler, capture);
        }
        this.listeners = [];
    }
}
