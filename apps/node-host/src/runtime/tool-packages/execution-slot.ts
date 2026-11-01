import type {Tool, ToolUseContext} from '@itookit/tools';
import {pinImplementation, type ImplementationRef} from './execution-records';
import type {RegisteredToolPackage} from './store';
import {createModuleLogger, randomUUID} from '@itookit/common';
const log = createModuleLogger('tool-package-execution');

/** Driver identities remain stable while each admitted call owns an immutable implementation. */
export class PackageExecutionSlot {
    readonly tool: Tool;
    private readonly running = new Map<string, number>();
    constructor(private current: Tool, private readonly registration: () => RegisteredToolPackage,
        private readonly resolve: (reference: ImplementationRef) => Promise<Tool>, private readonly idle: (version: string) => void,
        private readonly changed: () => void) {
        this.tool = new Proxy({} as Tool, {get: (_target, key) => {
            if (key === 'acquireExecution') return (context: ToolUseContext, phase: 'invoke' | 'reconcile') => this.acquire(context, phase);
            const value = Reflect.get(this.current, key, this.current); return typeof value === 'function' ? value.bind(this.current) : value;
        }});
    }
    replace(tool: Tool): void {this.current = tool;}
    counts(): Array<{version: string; count: number}> {return [...this.running].map(([version, count]) => ({version, count}));}
    private async acquire(context: ToolUseContext, phase: 'invoke' | 'reconcile') {
        const started = Date.now(), operationId = context.operationId ?? randomUUID();
        try {return await this.lease(context, phase, operationId, started);}
        catch (error) {
            const code = (error as {code?: string})?.code;
            log.warn('tool.package.execution', {operationId, stage: phase, result: 'failure', code: /^TOOL_PACKAGE_[A-Z_]+$/.test(code ?? '') ? code : 'TOOL_PACKAGE_IMPLEMENTATION_UNAVAILABLE', durationMs: Date.now() - started});
            throw error;
        }
    }
    private async lease(context: ToolUseContext, phase: 'invoke' | 'reconcile', operationId: string, started: number) {
        const reference = await pinImplementation(this.current, context, phase, this.registration);
        const release = this.retain(reference.version);
        try {
            const tool = await this.resolve(reference); context.signal?.throwIfAborted();
            log.info('tool.package.execution', {operationId, stage: phase, result: 'success', packageId: reference.packageId,
                version: reference.version, fingerprint: reference.fingerprint, durationMs: Date.now() - started});
            return {tool, release};
        } catch (error) {release(); throw error;}
    }
    private retain(version: string): () => void {
        this.running.set(version, (this.running.get(version) ?? 0) + 1); this.changed();
        let released = false;
        return () => {
            if (released) return; released = true;
            const count = this.running.get(version)! - 1;
            if (count) this.running.set(version, count);
            else {this.running.delete(version); this.idle(version);}
            this.changed();
        };
    }
}
