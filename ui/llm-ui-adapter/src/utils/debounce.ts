// @file: llm-ui/utils/debounce.ts

/**
 * 创建一个可取消的防抖函数
 */
export interface DebouncedFn {
    (): void;
    cancel(): void;
}

export function createDebouncedSave(
    fn: () => Promise<void>,
    delay: number,
    guard?: () => boolean
): DebouncedFn {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const debounced = () => {
        if (guard && !guard()) return;

        if (timer) clearTimeout(timer);

        timer = setTimeout(async () => {
            timer = null;
            if (guard && !guard()) return;
            await fn();
        }, delay);
    };

    debounced.cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };

    return debounced;
}
