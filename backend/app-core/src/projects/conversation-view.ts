import { FSError } from '@itookit/vfs-core';
import type { HarnessConversationPort, HarnessConversationSnapshot, HarnessUsage } from '@itookit/piagent-driver';
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
    private starting = 0;
    private polling: Promise<unknown> = Promise.resolve();
    private quoteFailed = false;
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
        this.listeners.add(listener); this.schedule();
        return () => { this.listeners.delete(listener); if (!this.listeners.size) { clearTimeout(this.timer); this.timer = undefined; } };
    }
    private schedule(): void {
        if (this.closed || this.timer || this.pumping || !this.listeners.size || !this.starting && !this.isActive(this.current)) return;
        this.timer = setTimeout(() => {
            this.timer = undefined; this.pumping = true;
            void this.invoke(this.source.poll, [], 'poll').catch(() => {}).finally(() => { this.pumping = false; this.schedule(); });
        }, 200);
    }
    private isActive(snapshot: ProjectConversationSnapshot): boolean { return !!(snapshot.active || snapshot.canInterrupt || snapshot.requests?.length); }
    private invoke(method: (...args: any[]) => unknown, args: unknown[], key: string): Promise<any> {
        if (this.closed) return Promise.reject(new FSError('EIO', 'Conversation view closed'));
        const execute = async () => {
            if (this.closed) throw new FSError('EIO', 'Conversation view closed');
            const starting = key === 'send' || key === 'command';
            if (starting) {++this.starting; this.schedule();}
            let result: any;
            try { result = await Reflect.apply(method, this.source, args); }
            finally {if (starting) --this.starting; if (!this.closed) {this.update(); this.schedule();}}
            return result && typeof result === 'object' && 'messages' in result ? this.current : result;
        };
        if (key === 'respond' || key === 'interrupt') return execute();
        if (key === 'poll' && this.starting) {
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
        if (!this.isActive(next)) { clearTimeout(this.timer); this.timer = undefined; }
        else this.schedule();
        for (const listener of this.listeners) { try { listener(); } catch (error) { console.warn('[Conversation] View listener failed', error); } }
    }
    private close(): Promise<void> {
        if (!this.closing) {
            this.closed = true; clearTimeout(this.timer); this.listeners.clear();
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
