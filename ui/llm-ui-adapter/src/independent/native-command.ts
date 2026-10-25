import {parseCommand} from '@itookit/llm-ui';
import type {ConversationControls, ConversationModelSelection, ConversationSlashCommand} from '@itookit/ui-common';

/** Both composer views preserve the submitted text while sharing native command semantics. */
export function resolveNativeCommand(text: string, commands: readonly ConversationSlashCommand[]) {
    const parsed = parseCommand(text);
    const command = parsed && commands.find(command => command.name === parsed.name && !command.disabled);
    return parsed && command ? {command, arguments: parsed.arguments} : undefined;
}

export function submitNativeCommand(controls: ConversationControls, command: ConversationSlashCommand | Pick<ConversationSlashCommand, 'name' | 'kind'>,
    args: string, text: string, selection?: ConversationModelSelection, submissionId?: string) {
    if ('execution' in command && command.execution === 'query' && controls.queryCommand && controls.snapshot?.().canQueryCommand)
        return controls.queryCommand(command.name, args, submissionId, command as ConversationSlashCommand);
    if ('revision' in command || 'id' in command || 'execution' in command) {
        const {id,revision,kind,execution} = command as ConversationSlashCommand;
        return controls.command!(command.name,args,kind === 'prompt' ? selection : undefined,text,submissionId,{id,revision,kind,execution});
    }
    if (submissionId) return controls.command!(command.name, args, command.kind === 'prompt' ? selection : undefined, text, submissionId);
    return controls.command!(command.name, args, command.kind === 'prompt' ? selection : undefined, text);
}
