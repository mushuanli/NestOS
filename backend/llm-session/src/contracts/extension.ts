// Extension system for the LLM subsystem (llm-runtime layer).
//
// Distinct from the VFS-layer IPlugin in common/interfaces/fs/plugin/.
// This is the LLM-specific plugin system following VS Code's contribution points model.
//
// Plugins contribute control-plane commands around the conversation store.

import type { ICommandBus } from './command-bus';
export interface ExtensionContext {
    /** Plugins contribute control-plane commands here. */
    commands: ICommandBus;
}

export interface ILLMPlugin {
    readonly name: string;
    activate(ctx: ExtensionContext): void;
    deactivate?(): void;
}

export interface IExtensionRegistry {
    /** Register a plugin. Must be called before activate(). */
    register(plugin: ILLMPlugin): void;
    /** Activate all registered plugins with the given context. */
    activate(ctx: ExtensionContext): void;
    /** Deactivate all plugins (e.g. on session teardown). */
    deactivate(): void;
}
