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

    /** Prepare all fallible metadata before a host commits its durable version pointer. */
    async prepareUpdate(tools: Tool[], expected: Tool[], published = tools): Promise<{check(): void; commit(): void; rollback(): void}> {
        if (new Set(tools.map(tool => tool.name)).size !== tools.length || tools.length !== published.length
            || tools.some((tool, index) => published[index]?.name !== tool.name))
            throw Object.assign(new Error('Invalid tool update identities'), {code: 'TOOL_PACKAGE_TOOL_INVALID'});
        const prior = new Map(expected.map(tool => [tool.name, tool]));
        const check = () => {
            if (this.closed) throw new Error('Tool registration runtime is closed');
            for (const tool of tools) if (this.tools.get(tool.name) !== prior.get(tool.name))
                throw Object.assign(new Error('Tool registration changed before activation'), {code: 'TOOL_PACKAGE_TOOL_CONFLICT'});
        };
        check();
        const staged = new ToolDeviceDriver(tools), previous = new ToolDeviceDriver(expected);
        try {
            await Promise.all([staged.init(), previous.init()]); check();
            const entries = published.map(tool => ({tool, meta: structuredClone(staged.getToolMeta(tool.name)!), definition: structuredClone(staged.getToolDefinition(tool.name)!)}));
            let committed = false;
            return {check, commit: () => {
                check();
                for (const entry of entries) {
                    for (const driver of this.drivers) driver.replaceToolInstance(entry.tool, {meta: structuredClone(entry.meta), definition: structuredClone(entry.definition)});
                    this.tools.set(entry.tool.name, entry.tool);
                }
                committed = true;
            }, rollback: () => {
                if (!committed) return;
                for (const tool of published.filter(tool => !prior.has(tool.name))) {
                    for (const driver of this.drivers) driver.unregisterTool(tool.name); this.tools.delete(tool.name);
                }
                for (const tool of expected) {
                    for (const driver of this.drivers) driver.replaceToolInstance(tool, {meta: structuredClone(previous.getToolMeta(tool.name)!), definition: structuredClone(previous.getToolDefinition(tool.name)!)});
                    this.tools.set(tool.name, tool);
                }
                committed = false;
            }};
        } finally {await staged.dispose();}
    }

    unregister(ids: string[]): Promise<void> {
        const work = this.tail.then(() => {
            if (this.closed) throw new Error('Tool registration runtime is closed');
            for (const id of ids) {for (const driver of this.drivers) driver.unregisterTool(id); this.tools.delete(id);}
        }); this.tail = work.catch(() => {}); return work;
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
