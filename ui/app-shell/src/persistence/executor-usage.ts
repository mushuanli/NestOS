import type { EditorOptions } from '@itookit/ui-common';
import type { VfsJsonStore } from './vfs-json-store';

import {EXECUTOR_USAGE_DOCUMENT} from './documents';
export {EXECUTOR_USAGE_DOCUMENT} from './documents';

/** UI recency is separate from Agent definitions and shared by the toolbox and composers. */
export class ExecutorUsage implements NonNullable<EditorOptions['executorUsage']> {
    private readonly times = new Map<string, number>();
    private readonly listeners = new Set<() => void>();
    private ready?: Promise<void>;
    constructor(private readonly documents: Pick<VfsJsonStore, 'read' | 'write'>) {}
    load(): Promise<void> {
        return this.ready ??= this.documents.read(EXECUTOR_USAGE_DOCUMENT).then(value => {
            if (!value || typeof value !== 'object') return;
            for (const [id, time] of Object.entries(value)) {
                if (typeof time === 'number' && Number.isFinite(time) && time > 0) this.times.set(id, Math.max(time, this.times.get(id) ?? 0));
            }
        });
    }
    lastUsed(id: string): number { return this.times.get(id) ?? 0; }
    record(id: string): void {
        this.times.set(id, Date.now());
        const entries = [...this.times].sort((a, b) => b[1] - a[1]).slice(0, 1000);
        this.times.clear(); entries.forEach(([key, time]) => this.times.set(key, time));
        this.documents.write(EXECUTOR_USAGE_DOCUMENT, Object.fromEntries(entries));
        for (const listener of this.listeners) {
            try { listener(); } catch (error) { console.error('[executor-usage] subscriber failed', error); }
        }
    }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
