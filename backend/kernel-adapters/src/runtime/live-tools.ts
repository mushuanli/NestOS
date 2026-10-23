import {ToolDeviceDriver, type Tool} from '@itookit/tools';

/** Share trusted additions across the catalog and every existing or future scope. */
export class LiveTools {
    private readonly tools = new Map<string, Tool>();
    private readonly drivers = new Set<ToolDeviceDriver>();
    private tail = Promise.resolve();
    private closed = false;

    constructor(initial: Tool[]) {for (const tool of initial) this.tools.set(tool.name, tool);}
    list(): Tool[] {return [...this.tools.values()];}
    attach(driver: ToolDeviceDriver): () => void {this.drivers.add(driver); return () => {this.drivers.delete(driver);};}

    register(additions: Tool[]): Promise<void> {
        const work = this.tail.then(() => this.commit(additions));
        this.tail = work.catch(() => {}); return work;
    }

    private async commit(additions: Tool[]): Promise<void> {
        if (this.closed) throw new Error('Tool registration runtime is closed');
        const pending = additions.filter(tool => this.tools.get(tool.name) !== tool);
        this.validate(pending);
        const staged = new ToolDeviceDriver(pending);
        try {
            await staged.init();
            if (this.closed) throw new Error('Tool registration runtime is closed');
            this.validate(pending);
            const prepared = pending.map(tool => ({tool, id: tool.name, updates: [...this.drivers].map(driver => ({driver,
                meta: structuredClone(staged.getToolMeta(tool.name)!), definition: structuredClone(staged.getToolDefinition(tool.name)!)}))}));
            for (const {tool, updates} of prepared) for (const {driver, meta, definition} of updates) driver.registerToolInstance(tool, {meta, definition});
            for (const {tool, id} of prepared) this.tools.set(id, tool);
        } finally {await staged.dispose();}
    }

    private validate(additions: Tool[]): void {
        const names = new Set<string>();
        for (const tool of additions) {
            if (!tool?.name || typeof tool.call !== 'function' || names.has(tool.name)) throw Object.assign(new Error('Invalid or duplicate package tool'), {code: 'TOOL_PACKAGE_TOOL_INVALID'});
            if (this.tools.has(tool.name) || [...this.drivers].some(driver => driver.getToolMeta(tool.name)))
                throw Object.assign(new Error(`Tool already registered: ${tool.name}`), {code: 'TOOL_PACKAGE_TOOL_CONFLICT'});
            names.add(tool.name);
        }
    }

    async close(): Promise<void> {this.closed = true; await this.tail; this.drivers.clear();}
}
