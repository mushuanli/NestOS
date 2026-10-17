// @file: llm-ui/components/input/plugins/InputPlugin.ts

/**
 * ChatInput 插件接口
 * 
 * 设计灵感：
 * - VS Code Extension API（activate/deactivate 生命周期）
 * - ProseMirror Plugin（统一的事件钩子）
 * - Warp 的输入增强管线
 * 
 * 每个 Plugin 独立管理自己的 UI 和状态，
 * ChatInput 只负责调用钩子，不知道插件内部实现。
 */

export interface InputPluginContext {
    /** 输入框元素 */
    textarea: HTMLTextAreaElement;
    /** 输入区容器（用于挂载弹出面板） */
    container: HTMLElement;
    /** 读取当前输入 */
    getText: () => string;
    /** 设置输入内容 */
    setText: (text: string) => void;
    /** 在光标位置插入 */
    insertAtCursor: (text: string) => void;
    /** 替换指定范围 */
    replaceRange: (start: number, end: number, text: string) => void;
    /** 获取光标位置 */
    getCursorPosition: () => number;
    /** 设置光标位置 */
    setCursorPosition: (pos: number) => void;
    /** 触发发送 */
    triggerSend: () => void;
    /** 聚焦输入框 */
    focus: () => void;
    /** 获取当前 Agent ID */
    getAgentId: () => string;
}

export interface InputPlugin {
    /** 唯一标识 */
    readonly id: string;

    /** 优先级（数字越小越先处理） */
    readonly priority?: number;

    /** 激活插件，接收上下文 */
    activate(ctx: InputPluginContext): void;

    /**
     * 键盘事件钩子
     * 返回 true 表示已处理（阻止后续插件和默认行为）
     */
    onKeyDown?(e: KeyboardEvent): boolean;

    /**
     * 输入变化钩子
     * 每次 textarea input 事件触发
     */
    onInput?(text: string, cursorPos: number): void;

    /**
     * 发送前钩子
     * 返回 false 阻止发送
     */
    onBeforeSend?(text: string): boolean | void;

    /**
     * 发送后钩子
     * 用于记录历史等
     */
    onAfterSend?(text: string, agentId: string): void;

    /**
     * 聚焦/失焦钩子
     */
    onFocus?(): void;
    onBlur?(): void;

    /** 销毁 */
    deactivate(): void;
}
