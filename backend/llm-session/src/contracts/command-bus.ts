// ICommandBus — plugin-contributed command registry (llm-runtime layer).
//
// SessionManager 30+ API → plugin-contributed commands.
// UI calls commands.execute('vcs.branch.create', args) instead of
// sessionManager.createBranch(args).
//
// Naming convention: '<plugin>.<verb>' (e.g., 'vcs.merge', 'session.send').

export interface Disposable {
    dispose(): void;
}

export interface CommandDescriptor {
    name: string;
    description?: string;
    plugin?: string;
}

export interface ICommandBus {
    /** Register a named command handler. Returns a Disposable to unregister. */
    register(name: string, handler: (args?: unknown) => Promise<unknown>): Disposable;
    /** Execute a registered command by name. Throws if command is not found. */
    execute<T = unknown>(name: string, args?: unknown): Promise<T>;
    /** List all registered commands (for command palette). */
    list(): CommandDescriptor[];
}
