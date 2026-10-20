import {parseCommand} from '@itookit/llm-ui';
import {t} from '@itookit/common';
import type {ConversationSlashCommand} from '@itookit/ui-common';

/** Host branch commands take precedence over native command names. */
export function nativeBranchCommand(text: string) {
    const command = parseCommand(text);
    return command && ['branch', 'branches'].includes(command.name) ? command : undefined;
}

export function withNativeBranchCommands(native: ConversationSlashCommand[]): ConversationSlashCommand[] {
    return [{name: 'branch', description: t('branch.create'), argumentHint: t('harness.branchName'), kind: 'action'},
        {name: 'branches', description: t('harness.branches'), kind: 'action'},
        ...native.filter(command => !['branch', 'branches'].includes(command.name))];
}
