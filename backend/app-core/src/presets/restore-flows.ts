import {createModuleLogger, randomUUID} from '@itookit/common';
import { FlowLibraryCommand } from '@itookit/app-contracts';
import { FlowCommand, type FlowDraft } from '@itookit/llm-flow/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import type { CommandBus } from '@itookit/llm-session';

/** Product recovery explicitly publishes newly restored templates, optionally replacing the selected template draft. */
export async function restoreAndPublishFlow(commands: ICommandBus, template: FlowDraft, overwrite = false): Promise<FlowDraft | null> {
    const operationId = randomUUID(), started = Date.now(), log = createModuleLogger('flow-recovery');
    let stage = 'restore';
    try {
        let draft = await commands.execute<FlowDraft | null>(FlowCommand.DraftRestore, structuredClone(template));
        if (!draft && overwrite) {
            stage = 'validate';
            const validation = await commands.execute<{valid: boolean}>(FlowCommand.DraftValidate, structuredClone(template));
            if (!validation.valid) throw new Error('FLOW_RECOVERY_TEMPLATE_INVALID');
            stage = 'replace';
            const current = await commands.execute<FlowDraft>(FlowCommand.DraftLoad, {id: template.id});
            const saved = await commands.execute<{draft: FlowDraft}>(FlowCommand.DraftSave, {
                draft: structuredClone(template), expectedDraftVersion: current.draftVersion,
            });
            draft = saved.draft;
        }
        stage = 'publish';
        if (draft) await commands.execute(FlowCommand.RevisionCreate, { draftId: draft.id, expectedDraftVersion: draft.draftVersion });
        log.info('flow.recovery', {operationId, stage, result: draft ? 'restored' : 'preserved', durationMs: Date.now() - started});
        return draft;
    } catch (error) {
        log.warn('flow.recovery', {operationId, stage, result: 'failure', code: 'FLOW_RECOVERY_FAILED', durationMs: Date.now() - started});
        throw error;
    }
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
