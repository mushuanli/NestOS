// CommandBus — llm-runtime layer command registry.
//
// Plugin-contributed commands replace SessionManager's 30+ method facade.
// UI calls commands.execute('vcs.branch.create', args) instead of
// directly invoking SessionManager.createBranch().

import type { ICommandBus, CommandDescriptor, Disposable } from '../contracts';

export class CommandBus implements ICommandBus {
    private readonly handlers = new Map<string, (args?: unknown) => Promise<unknown>>();
    private readonly descriptors = new Map<string, CommandDescriptor>();

    register(name: string, handler: (args?: unknown) => Promise<unknown>): Disposable {
        if (this.handlers.has(name)) {
            throw new Error(`Command already registered: ${name}`);
        }
        this.handlers.set(name, handler);
        this.descriptors.set(name, { name });

        return {
            dispose: () => {
                this.handlers.delete(name);
                this.descriptors.delete(name);
            },
        };
    }

    async execute<T = unknown>(name: string, args?: unknown): Promise<T> {
        const handler = this.handlers.get(name);
        if (!handler) {
            throw new Error(`Command not found: ${name}`);
        }
        return handler(args) as Promise<T>;
    }

    list(): CommandDescriptor[] {
        return Array.from(this.descriptors.values());
    }
}
