// history-plugin — prompt history commands.
//
// Wraps PromptHistoryService methods as ICommandBus commands.

import type { ILLMPlugin, ExtensionContext } from '../contracts';
import type { SessionManager } from '../session/session-manager';

export function createHistoryPlugin(sessionManager: SessionManager): ILLMPlugin {
    return {
        name: 'history',
        activate(ctx: ExtensionContext): void {
            const sm = sessionManager;

            ctx.commands.register('history.search', async (args) => {
                return sm.searchHistory(args as any);
            });
            ctx.commands.register('history.recent', async (args) => {
                const { count } = (args ?? {}) as { count?: number };
                return sm.getRecentPrompts(count);
            });
            ctx.commands.register('history.remove', async (args) => {
                const { text } = args as { text: string };
                return sm.removeFromHistory(text);
            });
            ctx.commands.register('history.clear', async () => sm.clearHistory());
            ctx.commands.register('history.count', async () => sm.getHistoryCount());
        },
    };
}
