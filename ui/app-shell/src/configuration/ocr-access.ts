import type { OcrService } from '@itookit/app-contracts/services';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { lazyResource } from '../lifecycle/lazy-resource';

/** Observing an empty input must not load OCR; bind its remote events on first use. */
export class OcrAccess {
    private readonly listeners = new Set<() => void>();
    private releaseAgents?: () => void;
    private service?: OcrService;
    private release?: () => void;
    private closed = false;
    private readonly resource;
    constructor(load: () => Promise<OcrService>, private readonly agents: IAgentManagementService) {
        this.resource = lazyResource(async () => {
            this.service = await load(); this.bind(); return this.service;
        }, () => this.unbind());
    }
    get(): Promise<OcrService> { return this.resource.get(); }
    subscribe(listener: () => void): () => void {
        if (this.closed) return () => {};
        const notify = () => listener();
        this.listeners.add(notify);
        this.releaseAgents ??= this.agents.onChange(() => this.notify());
        this.bind();
        return () => {
            this.listeners.delete(notify);
            if (!this.listeners.size) { this.unbind(); this.releaseAgents?.(); this.releaseAgents = undefined; }
        };
    }
    async close(): Promise<void> {
        this.closed = true;
        this.releaseAgents?.(); this.releaseAgents = undefined;
        this.listeners.clear(); this.unbind(); await this.resource.close();
    }
    private bind(): void {
        if (this.service && this.listeners.size && !this.release && !this.closed)
            this.release = this.service.subscribe(() => this.notify());
    }
    private notify(): void {
        for (const listener of this.listeners) {
            try { listener(); } catch { console.warn('[OCR] Observer failed'); }
        }
    }
    private unbind(): void { this.release?.(); this.release = undefined; }
}
