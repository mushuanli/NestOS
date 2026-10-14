// @file: llm-ui/components/common/DOMCache.ts

/**
 * DOM 元素缓存
 *
 * 缓存 ID 选择器的查询结果，避免重复 querySelector。
 * 使用 WeakRef 避免阻止 GC（元素被移除后自动失效）。
 */
export class DOMCache {
    private cache = new Map<string, WeakRef<HTMLElement>>();

    constructor(private root: HTMLElement) { }

    /**
     * 根据 ID 获取元素（带缓存）
     */
    byId(id: string): HTMLElement | null {
        const ref = this.cache.get(id);
        if (ref) {
            const el = ref.deref();
            if (el && el.isConnected) return el;
            this.cache.delete(id);
        }

        const el = this.root.querySelector(`#${id}`) as HTMLElement | null;
        if (el) {
            this.cache.set(id, new WeakRef(el));
        }
        return el;
    }

    /**
     * 清除指定缓存或全部缓存
     */
    invalidate(id?: string): void {
        if (id) {
            this.cache.delete(id);
        } else {
            this.cache.clear();
        }
    }

    destroy(): void {
        this.cache.clear();
    }
}
