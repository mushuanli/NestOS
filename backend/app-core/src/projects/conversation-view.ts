import { FSError } from '@itookit/vfs-core';
import type { HarnessConversationPort, HarnessConversationSnapshot, HarnessUsage } from '@itookit/nestos-node-driver';
import type { UsageCostEstimate } from '@itookit/kernel-adapters/contracts';

import type { ProjectConversationPort, ProjectConversationSnapshot } from '@itookit/app-contracts/services';
/** One host-side cursor pump serves every subscriber to this conversation view. */
export function observeConversation(source: HarnessConversationPort, quote?: (usage: HarnessUsage) => UsageCostEstimate, conversationId?: string, activityChanged?: () => void): ProjectConversationPort {
    return new ConversationView(source, quote, conversationId, activityChanged).port();
}
class ConversationView {
    private readonly listeners = new Set<() => void>();
    private current: ProjectConversationSnapshot;
    private timer?: ReturnType<typeof setTimeout>;
    private tail: Promise<unknown> = Promise.resolve();
    private closing?: Promise<void>;
    private closed = false;
    private pumping = false;
    private observingDispatch = false;
    private stopSource?: () => void;
    private eventTimer?: ReturnType<typeof setTimeout>;
    private refreshRequested = false;
    private starting = 0;
    private polling: Promise<unknown> = Promise.resolve();
    private quoteFailed = false;
    private failures = 0;
    constructor(private readonly source: HarnessConversationPort, private readonly quote?: (usage: HarnessUsage) => UsageCostEstimate, private readonly conversationId?: string,
        private readonly activityChanged?: () => void) {
        this.current = immutableData(undefined, this.project(source.snapshot()));
    }
    private project(snapshot: HarnessConversationSnapshot): ProjectConversationSnapshot {
        try {
            const usageEstimate = snapshot.usage && !snapshot.usageUnavailable ? this.quote?.(snapshot.usage) : undefined;
            this.quoteFailed = false;
            return {...snapshot, usageEstimate};
        } catch {
            if (!this.quoteFailed) console.warn('[Conversation] Usage estimation unavailable', {sessionId: snapshot.sessionId});
            this.quoteFailed = true;
            return {...snapshot, usageEstimate: undefined};
        }
    }
    port(): ProjectConversationPort {
        return new Proxy(this.source as ProjectConversationPort, { get: (target, key) => {
            if (key === 'conversationId') return this.conversationId;
            if (key === 'snapshot') return () => this.current;
            if (key === 'subscribe') return (listener: () => void) => this.subscribe(listener);
            if (key === 'close') return () => this.close();
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? (...args: unknown[]) => this.invoke(value, args, String(key)) : value;
        } });
    }
    private subscribe(listener: () => void): () => void {
        if (this.closed) throw new FSError('EIO', 'Conversation view closed');
        this.listeners.add(listener);
        this.stopSource ??= this.source.subscribe(() => this.invalidate());
        this.schedule();
        return () => {
            this.listeners.delete(listener);
            if (!this.listeners.size) {
                this.stopSource?.(); this.stopSource = undefined;
                clearTimeout(this.timer); clearTimeout(this.eventTimer); this.timer = undefined; this.eventTimer = undefined;
            }
        };
    }
    private invalidate(): void {
        if (this.closed || !this.listeners.size || this.eventTimer) return;
        this.eventTimer = setTimeout(() => {
            this.eventTimer = undefined;
            if (this.pumping) this.observeDispatch(); else this.pump();
        },20);
    }
    private pump(): void {
        if (this.closed || !this.listeners.size || this.pumping) return;
        this.pumping = true;
        void this.invoke(this.source.refresh, [], 'refresh').catch(() => {}).finally(() => {
            this.pumping = false;
            if (this.refreshRequested) { this.refreshRequested = false; this.invalidate(); }
            this.schedule();
        });
    }
    private dispatching(): boolean {
        return this.source.snapshot().instructionQueue?.items[0]?.state === 'dispatching';
    }
    private observeDispatch(): void {
        if (!this.dispatching() || this.observingDispatch) {this.refreshRequested = true; return;}
        this.observingDispatch = true;
        void this.invoke(this.source.refresh, [], 'observe-dispatch').catch(() => {}).finally(() => {
            this.observingDispatch = false;
            if (this.refreshRequested) {this.refreshRequested = false; this.invalidate();}
        });
    }
    private schedule(): void {
        if (this.closed || this.timer || this.pumping || !this.listeners.size) return;
        this.timer = setTimeout(() => { this.timer = undefined; this.pump(); },15_000);
    }
    private isActive(snapshot: ProjectConversationSnapshot): boolean { return !!(snapshot.active || snapshot.canInterrupt || snapshot.requests?.length); }
    private invoke(method: (...args: any[]) => unknown, args: unknown[], key: string): Promise<any> {
        if (this.closed) return Promise.reject(new FSError('EIO', 'Conversation view closed'));
        const execute = async () => {
            if (this.closed) throw new FSError('EIO', 'Conversation view closed');
            const starting = key === 'send' || key === 'command';
            if (starting) {++this.starting; clearTimeout(this.timer); this.timer = undefined; this.schedule();}
            let result: any, succeeded = false;
            try { result = await Reflect.apply(method, this.source, args); succeeded = true; }
            finally {
                if (starting) --this.starting;
                if (key === 'refresh' || key === 'read' || key === 'observe-dispatch') {
                    const state = this.source.snapshot();
                    this.failures = !succeeded || state.disconnected || state.observation?.refreshError ? this.failures + 1 : 0;
                }
                if (!this.closed) {this.update(); this.schedule(); if (key === 'enqueue' || key === 'editInstructionQueue') this.invalidate();}
            }
            return result && typeof result === 'object' && 'messages' in result ? this.current : result;
        };
        if (['readCommandOutput', 'loadCommandOutput', 'reconcileQuery', 'queryCommand', 'commands', 'models', 'respond', 'interrupt', 'reconcileControl', 'enqueue', 'editInstructionQueue', 'saveDraft', 'read'].includes(key)) return execute();
        if (key === 'observe-dispatch' || key === 'refresh' && this.starting) {
            const work = this.polling.then(execute); this.polling = work.catch(() => {}); return work;
        }
        const work = this.tail.then(execute);
        this.tail = work.catch(() => {}); return work;
    }
    private update(): void {
        const next = immutableData(this.current, this.project(this.source.snapshot()));
        if (next === this.current) return;
        const activityChanged = this.isActive(this.current) !== this.isActive(next);
        this.current = next;
        if (activityChanged) this.activityChanged?.();
        if (activityChanged) {clearTimeout(this.timer); this.timer = undefined;}
        this.schedule();
        for (const listener of this.listeners) { try { listener(); } catch (error) { console.warn('[Conversation] View listener failed', error); } }
    }
    private close(): Promise<void> {
        if (!this.closing) {
            this.closed = true; clearTimeout(this.timer); clearTimeout(this.eventTimer); this.stopSource?.(); this.listeners.clear();
            const closing = this.source.close();
            this.closing = Promise.all([this.tail, this.polling, closing]).then(() => {});
        }
        return this.closing;
    }
}
/** Preserve immutable message identities while comparing mutable driver snapshots. */
function immutableData<T>(previous: T | undefined, next: T): T {
    if (previous === next || !next || typeof next !== 'object') return next;
    if (Array.isArray(next)) {
        const before = Array.isArray(previous) ? previous : [];
        const indexed = new Map(before.filter(item => item && typeof item === 'object' && 'id' in item).map(item => [item.id, item]));
        const rows = next.map((item, index) => immutableData(item && typeof item === 'object' && 'id' in item ? indexed.get(item.id) : before[index], item));
        return (Array.isArray(previous) && rows.length === before.length && rows.every((row, index) => row === before[index]) ? previous : Object.freeze(rows)) as T;
    }
    const before = previous && typeof previous === 'object' ? previous as Record<string, unknown> : {};
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(next)) result[key] = immutableData(before[key], value);
    return (previous && typeof previous === 'object' && !Array.isArray(previous) && Object.keys(before).length === Object.keys(result).length && Object.keys(result).every(key => Object.hasOwn(before, key) && before[key] === result[key])
        ? previous : Object.freeze(result)) as T;
}
