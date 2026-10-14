// ExtensionRegistry — manages ILLMPlugin lifecycle.
//
// Plugins are registered before activate() is called.
// activate() is called once when the session engine initializes.

import type { IExtensionRegistry, ILLMPlugin, ExtensionContext } from '../contracts';

export class ExtensionRegistry implements IExtensionRegistry {
    private readonly plugins: ILLMPlugin[] = [];
    private ctx: ExtensionContext | null = null;

    register(plugin: ILLMPlugin): void {
        if (this.ctx) {
            throw new Error(`ExtensionRegistry already activated — register plugin "${plugin.name}" before activate()`);
        }
        this.plugins.push(plugin);
    }

    activate(ctx: ExtensionContext): void {
        this.ctx = ctx;
        for (const plugin of this.plugins) {
            plugin.activate(ctx);
        }
    }

    deactivate(): void {
        for (const plugin of this.plugins) {
            plugin.deactivate?.();
        }
        this.ctx = null;
    }
}
