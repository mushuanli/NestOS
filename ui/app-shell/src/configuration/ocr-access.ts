import type { OcrService } from '@itookit/app-contracts/services';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { lazyResource } from '../lifecycle/lazy-resource';

/** Observing an empty input must not load OCR; bind its remote events on first use. */
export class OcrAccess {
    private readonly listeners = new Map<() => void, () => void>();
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
        this.listeners.set(notify, this.agents.onChange(notify)); this.bind();
        return () => {
            this.listeners.get(notify)?.(); this.listeners.delete(notify);
            if (!this.listeners.size) this.unbind();
        };
    }
    async close(): Promise<void> {
        this.closed = true;
        for (const stop of this.listeners.values()) stop();
        this.listeners.clear(); this.unbind(); await this.resource.close();
    }
    private bind(): void {
        if (this.service && this.listeners.size && !this.release && !this.closed)
            this.release = this.service.subscribe(() => { for (const notify of this.listeners.keys()) notify(); });
    }
    private unbind(): void { this.release?.(); this.release = undefined; }
}
