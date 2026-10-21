import type { KernelViewPort } from '@itookit/durable-kernel/contracts';
import type { FSNode } from '@itookit/vfs-core';
import {randomUUID} from '@itookit/common';
import { resolveBrowserTarget } from './browser-routes';

/** Cache only small derived summaries; Task bodies and conversation history stay cold. */
export class SessionActivityProjection {
    private readonly cache = new Map<string, Promise<unknown>>();
    constructor(private readonly kernel: KernelViewPort) {}
    invalidate(sessionId?: string) { if (sessionId) this.cache.delete(sessionId); else this.cache.clear(); }
    async nodes(nodes: FSNode[]): Promise<FSNode[]> {
        if (!this.kernel.sessionActivity) return nodes;
        const result = [...nodes]; let next = 0;
        await Promise.all(Array.from({length: Math.min(nodes.length, 8)}, async () => {
            while (next < nodes.length) { const index = next++; result[index] = await this.node(nodes[index]!); }
        }));
        return result;
    }
    private async node(node: FSNode): Promise<FSNode> {
        let target;
        try { target = resolveBrowserTarget(String(node.metadata.navigationTarget ?? node.path)); } catch { return node; }
        if (target.kind !== 'session') return node;
        const activity = await this.read(target.sessionId);
        return activity ? {...node, metadata: {...node.metadata, sessionActivity: activity}} : node;
    }
    private read(sessionId: string): Promise<unknown> {
        const cached = this.cache.get(sessionId); if (cached) return cached;
        const started = Date.now(), operationId = randomUUID();
        const work: Promise<unknown> = this.kernel.sessionActivity!(sessionId).catch(error => {
            if (error?.code === 'SESSION_NOT_FOUND') return undefined;
            if (this.cache.get(sessionId) === work) this.cache.delete(sessionId);
            console.warn('[session-activity]', {operation: 'session.activity', stage: 'read', outcome: 'error',
                operationId, sessionId, durationMs: Date.now() - started, error: typeof error?.code === 'string' ? error.code : 'ACTIVITY_READ_FAILED'});
            return {unknown: true};
        });
        if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(sessionId, work); return work;
    }
}
