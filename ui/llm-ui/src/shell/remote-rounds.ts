import { t } from '@itookit/common';
import type { ConversationMessage } from '@itookit/ui-common';
import type { SessionGroup, ExecutionNode } from '@itookit/llm-session/contracts';

interface Round { key: string; users: ConversationMessage[]; responses: ConversationMessage[] }

/** Turn identities survive paging; older clients fall back to user-message boundaries. */
export function remoteRounds(messages: ConversationMessage[]): SessionGroup[] {
    const rounds = new Map<string, Round>(); let current: Round | undefined;
    for (const message of messages) {
        const key = message.turnId && message.turnId !== 'rollout-history' ? 'turn:' + message.turnId : message.role === 'user' ? 'prompt:' + message.id : current?.key ?? 'history:' + message.id;
        current = rounds.get(key) ?? {key, users: [], responses: []};
        rounds.set(key, current);
        (message.role === 'user' ? current.users : current.responses).push(message);
    }
    return [...rounds.values()].flatMap(projectRound);
}

function projectRound(round: Round): SessionGroup[] {
    const id = 'native-' + Array.from(round.key).map(char => char.codePointAt(0)!.toString(16)).join('-');
    const groups: SessionGroup[] = [];
    if (round.users.length) groups.push({id: id + '-user', role: 'user', timestamp: firstTime(round.users),
        content: round.users.filter(message => !message.id.startsWith('submitted:') || !round.users.some(native => !native.id.startsWith('submitted:') && native.text === message.text))
            .flatMap(message => message.contentParts ?? [message.text]).filter(Boolean).join('\n\n---\n\n')});
    if (round.responses.length) {
        const root: ExecutionNode = {id: id + '-output', executorId: 'native', executorType: 'agent', messageRole: 'assistant',
            name: t('harness.roleAssistant'), status: responseStatus(round.responses), startTime: firstTime(round.responses),
            endTime: round.responses.at(-1)?.timestamp,
            data: {output: round.responses.map(messageMarkdown).join('\n\n'), metaInfo: {nativeRole: 'assistant'}}};
        groups.push({id: id + '-response', role: 'assistant', timestamp: root.startTime, executionRoot: root});
    }
    return groups;
}
function firstTime(messages: ConversationMessage[]): number { return messages.find(message => Number.isFinite(message.timestamp) && message.timestamp! > 0)?.timestamp ?? 0; }

function responseStatus(messages: ConversationMessage[]): ExecutionNode['status'] {
    if (messages.some(message => ['running', 'queued', 'inProgress', 'in_progress'].includes(message.status ?? ''))) return 'running';
    if (messages.some(message => message.status === 'failed')) return 'failed';
    if (messages.some(message => ['aborted', 'cancelled'].includes(message.status ?? ''))) return 'aborted';
    return 'success';
}

function messageMarkdown(message: ConversationMessage): string {
    if (message.role === 'assistant') return message.text;
    if (message.role === 'system') return `### ${t('harness.roleSystem')}\n\n${codeBlock(message.text, 'text')}`;
    const name = (message.name ?? t('harness.roleTool')).replace(/[\r\n]/g, ' ').replace(/([\\`*_{}\[\]()#+.!|<>])/g, '\\$1');
    const operation = message.operation ? t(`harness.toolOperation.${message.operation}`) : '';
    const details = [message.commandPreview ? pathSpan(message.commandPreview) : '', ...(message.paths ?? []).map(pathSpan)].filter(Boolean);
    return `- **${name}**${operation ? ' · ' + operation : ''}${details.length ? ' · ' + details.join(' · ') : ''}`;
}
function pathSpan(path: string): string {
    const text = path.replace(/[\r\n]/g, ' '), fence = '`'.repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length)) + 1);
    return `${fence} ${text} ${fence}`;
}

function codeBlock(text: string, language: string): string {
    let length = 3;
    for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
    const fence = '`'.repeat(length);
    return `${fence}${language}\n${text}\n${fence}`;
}
