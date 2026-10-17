// @file: llm-ui/shell/EditorEventBus.ts

import { EventBus as CoreEventBus } from '@itookit/vfs-core';
import type { IEditorEventBus, EditorBusEvents, EditorEventKey } from '../domain/events';

/**
 * 编辑器内部事件总线 — 实例级（非全局单例）
 */
export class EditorEventBus implements IEditorEventBus {
    private bus = new CoreEventBus<EditorBusEvents>();

    on<K extends EditorEventKey>(event: K, callback: (payload: EditorBusEvents[K]) => void): () => void {
        return this.bus.on(event, (payload) => callback(payload));
    }

    emit<K extends EditorEventKey>(event: K, payload: EditorBusEvents[K]): void {
        this.bus.emit(event, payload);
    }

    once<K extends EditorEventKey>(event: K, callback: (payload: EditorBusEvents[K]) => void): () => void {
        return this.bus.once(event, (payload) => callback(payload));
    }

    destroy(): void {
        this.bus.clear();
    }
}
