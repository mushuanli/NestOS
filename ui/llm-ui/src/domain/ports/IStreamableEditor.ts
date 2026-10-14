// @file: llm-ui/domain/ports/IStreamableEditor.ts

/**
 * 可流式编辑器的能力接口
 *
 * 核心契约：
 * 1. appendDelta() 是增量的，不触发全量重建
 * 2. flush() 执行实际渲染，返回高度变化量
 * 3. finalize() 做一次完整渲染确保最终状态正确
 * 4. 编辑器不知道也不关心滚动容器（SRP）
 *
 * 使用场景：
 * - MDxController 实现此接口
 * - StreamController 通过此接口协调渲染
 */
export interface IStreamableEditor {
    /**
     * 追加增量内容（仅内存操作，不触发渲染）
     */
    appendDelta(chunk: string): void;

    /**
     * 执行渲染，返回高度变化量（像素）
     * 由 StreamController 在适当时机调用
     */
    flush(): Promise<number>;

    /**
     * 结束流式，执行最终完整渲染
     */
    finalize(): Promise<void>;

    /**
     * 当前完整内容
     */
    readonly content: string;

    /**
     * 是否有待渲染的内容
     */
    readonly hasPending: boolean;

    /**
     * 销毁
     */
    destroy(): void;
}
