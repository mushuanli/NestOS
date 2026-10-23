import { FlowLibraryCommand } from '@itookit/app-contracts';
import { FlowCommand, type FlowDraft } from '@itookit/llm-flow/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { CommandBus } from '@itookit/llm-session';

/** Product recovery explicitly publishes newly restored templates, preserving user drafts. */
export async function restoreAndPublishFlow(commands: ICommandBus, template: FlowDraft): Promise<FlowDraft | null> {
    const draft = await commands.execute<FlowDraft | null>(FlowCommand.DraftRestore, structuredClone(template));
    if (draft) await commands.execute(FlowCommand.RevisionCreate, { draftId: draft.id, expectedDraftVersion: draft.draftVersion });
    return draft;
}

export function registerFlowLibraryRecovery(commands: CommandBus, ensure?: (flowId: string) => Promise<void>): { dispose(): void } {
    return commands.register(FlowLibraryCommand.Restore, async args => {
        const templates = (args as { templates?: FlowDraft[] } | undefined)?.templates;
        if (!Array.isArray(templates)) throw new Error('Flow templates are required');
        let restored = 0;
        for (const template of templates) {
            if (await restoreAndPublishFlow(commands, template)) restored++;
            await ensure?.(template.id);
        }
        return restored;
    });
}
