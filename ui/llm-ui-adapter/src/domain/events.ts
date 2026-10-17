// @file: llm-ui/domain/events.ts

/**
 * 编辑器内部事件类型定义
 * 
 * 独立于 EventBus 实现，只定义契约。
 * EventBus 实现在 shell/ 层。
 */
export interface EditorBusEvents {
    // 分支
    'branch:create': { sourceNodeId: string };
    'branch:switch': { branchName: string };
    'branch:switchById': { headNodeId: string };
    'branch:rename': { oldName: string; newName: string };
    'branch:delete': { branchName: string };

    // 导航
    'nav:scrollTo': { sessionId: string };
    'nav:toggleFold': { sessionId: string };
    'nav:foldAll': {};
    'nav:unfoldAll': {};

    // 批量
    'batch:delete': { ids: string[] };
    'batch:copy': { ids: string[] };

    // 内容
    'content:copy': { sessionId: string };

    // 状态通知
    'state:collapseChanged': { states: Record<string, boolean> };
    'state:inputChanged': {};
}

export type EditorEventKey = keyof EditorBusEvents;

/**
 * EventBus 接口（供 Command/Component 依赖）
 */
export interface IEditorEventBus {
    on<K extends EditorEventKey>(event: K, callback: (payload: EditorBusEvents[K]) => void): () => void;
    emit<K extends EditorEventKey>(event: K, payload: EditorBusEvents[K]): void;
    once<K extends EditorEventKey>(event: K, callback: (payload: EditorBusEvents[K]) => void): () => void;
    destroy(): void;
}
