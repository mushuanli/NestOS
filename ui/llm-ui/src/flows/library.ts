import type { FlowDraft } from '@itookit/llm-flow/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { FlowCommand } from '@itookit/llm-flow/contracts';

export async function installFlowLibrary(commands: ICommandBus, library: readonly FlowDraft[]): Promise<void> {
    for (const template of library) await commands.execute(FlowCommand.DraftInstall, structuredClone(template));
}

/** Explicit user action; restore only missing files and retain installation receipts. */
export async function restoreFlowLibrary(commands: ICommandBus, library: readonly FlowDraft[]): Promise<number> {
    let restored = 0;
    for (const template of library) if (await commands.execute<FlowDraft | null>(FlowCommand.DraftRestore, structuredClone(template))) restored++;
    return restored;
}
