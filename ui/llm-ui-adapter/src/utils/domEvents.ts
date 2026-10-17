// @file: llm-ui/utils/domEvents.ts
//
// 事件委托工具 — 在一个长期存在的容器上绑定单个监听器,
// 按 CSS 选择器把事件分派给匹配的子元素。
//
// 解决的问题:很多视图用 `innerHTML` 重渲染列表,然后对每个子元素
// 重新 addEventListener。这样每次重渲染都要重绑全部监听器,且容易漏掉
// removeEventListener 造成泄漏。委托只绑一次,子元素随便重渲染。

export interface DelegateHandlerArg {
    /** 触发事件 */
    event: Event;
    /** 匹配选择器的元素(从 event.target 向上查找到的最近祖先) */
    target: HTMLElement;
    /** target.dataset.index 解析为数字(列表项常用),无则 NaN */
    index: number;
}

/**
 * 在 container 上绑定事件委托。返回解绑函数。
 *
 * @example
 * const off = delegate(this.attachmentContainer, 'click', '.remove-btn',
 *     ({ index }) => this.files.splice(index, 1));
 * // 之后随意 container.innerHTML = ...,无需重绑;销毁时 off()。
 */
export function delegate(
    container: HTMLElement,
    type: string,
    selector: string,
    handler: (arg: DelegateHandlerArg) => void,
): () => void {
    const listener = (event: Event) => {
        const start = event.target as HTMLElement | null;
        const match = start?.closest(selector) as HTMLElement | null;
        // 仅当匹配元素确实位于本容器内才分派
        if (!match || !container.contains(match)) return;
        const idx = match.dataset.index;
        handler({
            event,
            target: match,
            index: idx !== undefined ? parseInt(idx, 10) : NaN,
        });
    };
    container.addEventListener(type, listener);
    return () => container.removeEventListener(type, listener);
}
