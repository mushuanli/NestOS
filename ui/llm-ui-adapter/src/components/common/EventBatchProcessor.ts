// @file: llm-ui/components/common/EventBatchProcessor.ts

/**
 * 泛化的事件批处理器
 * 
 * Layer 0: 不依赖任何业务类型
 * 
 * 性能优化：
 * - 可合并事件（chunk/status）在缓冲期内合并，减少渲染次数
 * - 不可合并事件立即处理（先 flush 队列保证顺序）
 * - 自适应间隔：高频事件自动增大间隔，低频自动缩短
 */
export interface BatchableEvent {
    type: string;
    payload?: any;
}

export interface BatchedEvents<T extends BatchableEvent = BatchableEvent> {
    chunks: Map<string, { thought: string; output: string }>;
    statusChanges: Map<string, { status: string; result?: any }>;
    immediate: T[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metaUpdates: Map<string, Record<string, any>>;
}

export interface EventBatchProcessorOptions {
    interval?: number;
    immediateTypes?: string[];
    chunkEventType?: string;
    statusEventType?: string;
}

export class EventBatchProcessor<T extends BatchableEvent = BatchableEvent> {
    private queue: T[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;

    private currentInterval: number;
    private readonly MIN_INTERVAL = 30;
    private readonly MAX_INTERVAL = 150;

    private readonly immediateTypes: Set<string>;
    private readonly chunkType: string;
    private readonly statusType: string;

    constructor(
        private onFlush: (batched: BatchedEvents<T>) => void,
        private onImmediate: (event: T) => void,
        options?: EventBatchProcessorOptions
    ) {
        this.currentInterval = options?.interval ?? 50;
        this.immediateTypes = new Set(options?.immediateTypes ?? []);
        this.chunkType = options?.chunkEventType ?? 'message:updated';
        this.statusType = options?.statusEventType ?? 'message:status';
    }

    push(event: T): void {
        if (this.immediateTypes.has(event.type) || (event.type === this.chunkType && typeof event.payload?.content === 'string')) {
            this.flush();
            this.onImmediate(event);
            return;
        }

        this.queue.push(event);
        this.scheduleFlush();
    }

    flush(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.queue.length === 0) return;

        const events = this.queue;
        this.queue = [];

        const batched = this.mergeEvents(events);
        this.adjustInterval(events.length);
        this.onFlush(batched);
    }

    private scheduleFlush(): void {
        if (this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flush();
        }, this.currentInterval);
    }

    private mergeEvents(events: T[]): BatchedEvents<T> {
        const result: BatchedEvents<T> = {
            chunks: new Map(),
            statusChanges: new Map(),
            immediate: [],
            metaUpdates: new Map(),
        };

        for (const event of events) {
            if (event.type === this.chunkType) {
                const p = event.payload ?? {};
                const messageId = p.messageId;
                const delta = p.delta;
                const field = p.field;
                if (!delta || !field) {
                    // metaInfo-only — collect for TtyController / other meta handlers
                    if (messageId && p.metaInfo) {
                        const prev = result.metaUpdates.get(messageId) ?? {};
                        result.metaUpdates.set(messageId, { ...prev, ...p.metaInfo });
                    }
                    continue;
                }

                if (!result.chunks.has(messageId)) {
                    result.chunks.set(messageId, { thought: '', output: '' });
                }
                const merged = result.chunks.get(messageId)!;
                if (field === 'thought') merged.thought += delta;
                else if (field === 'output') merged.output += delta;

            } else if (event.type === this.statusType) {
                const p = event.payload ?? {};
                const { messageId, status, result: r } = p;
                result.statusChanges.set(messageId, { status, result: r });

            } else {
                result.immediate.push(event);
            }
        }

        return result;
    }

    private adjustInterval(eventCount: number): void {
        if (eventCount > 20) {
            this.currentInterval = Math.min(this.currentInterval * 1.2, this.MAX_INTERVAL);
        } else if (eventCount < 5) {
            this.currentInterval = Math.max(this.currentInterval * 0.8, this.MIN_INTERVAL);
        }
    }

    destroy(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.queue = [];
    }
}
