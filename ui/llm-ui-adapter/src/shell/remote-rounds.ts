import { t } from '@itookit/common';
import type { ConversationMessage } from '@itookit/ui-common';
import type { SessionGroup, ExecutionNode } from '@itookit/llm-session/contracts';
import { TRANSCRIPT_CONTEXT, TRANSCRIPT_SYSTEM, TRANSCRIPT_TOOL, contextLabel, transcriptCodeBlock, type TranscriptEncoder } from './transcript-markup';

interface Round { key: string; users: ConversationMessage[]; responses: ConversationMessage[] }
interface UserPart { markdown: string; context: boolean }

/** Keep presentation IDs separate from the native identities used by branch commands. */
export function remoteBranchTargets(messages: ConversationMessage[]): Array<{id: string; messageId: string; turnId?: string; latest: boolean}> {
    const rounds = collectRounds(messages);
    return rounds.filter(round => round.users.length).map(round => ({id: roundId(round) + '-user',
        messageId: round.users[0].id, turnId: round.users.find(message => message.turnId)?.turnId,
        latest: round === rounds.at(-1)}));
}

/** Turn identities survive paging; older clients fall back to user-message boundaries. */
export function remoteRounds(messages: ConversationMessage[], encode: TranscriptEncoder = transcriptCodeBlock): SessionGroup[] {
    return collectRounds(messages).flatMap(round => projectRound(round, encode));
}

/** Use explicit source metadata; never guess that ordinary prompt text is injected context. */
export function remotePrompts(messages: ConversationMessage[]): Array<{id: string; text: string}> {
    return collectRounds(messages).flatMap(round => {
        const parts = userParts(round.users, true);
        return parts.length ? [{id: roundId(round) + '-user', text: parts.map(part => part.markdown).join('\n\n')}] : [];
    });
}

function collectRounds(messages: ConversationMessage[]): Round[] {
    const rounds = new Map<string, Round>(); let current: Round | undefined;
    for (const message of messages) {
        const key = message.turnId && message.turnId !== 'rollout-history' ? 'turn:' + message.turnId : message.role === 'user' ? 'prompt:' + message.id : current?.key ?? 'history:' + message.id;
        current = rounds.get(key) ?? {key, users: [], responses: []};
        rounds.set(key, current);
        (message.role === 'user' ? current.users : current.responses).push(message);
    }
    return [...rounds.values()];
}

function roundId(round: Round): string { return 'native-' + Array.from(round.key).map(char => char.codePointAt(0)!.toString(16)).join('-'); }
function projectRound(round: Round, encode: TranscriptEncoder): SessionGroup[] {
    const id = roundId(round);
    const groups: SessionGroup[] = [];
    if (round.users.length) groups.push({id: id + '-user', role: 'user', timestamp: firstTime(round.users),
        content: userContent(round.users, encode)});
    if (round.responses.length) {
        const root: ExecutionNode = {id: id + '-output', executorId: 'native', executorType: 'agent', messageRole: 'assistant',
            name: t('harness.roleAssistant'), status: responseStatus(round.responses), startTime: firstTime(round.responses),
            endTime: round.responses.at(-1)?.timestamp,
            data: {output: round.responses.map(message => messageMarkdown(message, encode)).join('\n\n'), metaInfo: {nativeRole: 'assistant'}}};
        groups.push({id: id + '-response', role: 'assistant', timestamp: root.startTime, executionRoot: root});
    }
    return groups;
}
function firstTime(messages: ConversationMessage[]): number { return messages.find(message => Number.isFinite(message.timestamp) && message.timestamp! > 0)?.timestamp ?? 0; }

function userContent(messages: ConversationMessage[], encode: TranscriptEncoder): string {
    const parts = userParts(messages, false, encode);
    return parts.map((part, index) => {
        const separator = !index ? '' : part.context || parts[index - 1].context ? '\n\n' : '\n\n---\n\n';
        return separator + part.markdown;
    }).join('');
}

function userParts(messages: ConversationMessage[], omitContext = false, encode: TranscriptEncoder = transcriptCodeBlock): UserPart[] {
    return messages.filter(message => !message.id.startsWith('submitted:')
        || !messages.some(native => !native.id.startsWith('submitted:') && native.text === message.text))
        .flatMap(message => userMarkdown(message, omitContext, encode)).filter(part => Boolean(part.markdown) || (omitContext && !part.context));
}

function userMarkdown(message: ConversationMessage, omitContext: boolean, encode: TranscriptEncoder): UserPart[] {
    const parts = message.contentParts ?? [message.text];
    const kinds = message.contentPartKinds?.length === parts.length ? message.contentPartKinds : undefined;
    return parts.map((text, index) => {
        const kind = kinds?.[index];
        if (!kind || !contextLabel(kind)) return {markdown: text, context: false};
        if (omitContext) return {markdown: '', context: true};
        return {markdown: encode(text, `${TRANSCRIPT_CONTEXT} ${encodeURIComponent(message.id)}:${index} ${kind}`), context: true};
    });
}

function responseStatus(messages: ConversationMessage[]): ExecutionNode['status'] {
    if (messages.some(message => ['running', 'queued', 'inProgress', 'in_progress'].includes(message.status ?? ''))) return 'running';
    if (messages.some(message => message.status === 'failed')) return 'failed';
    if (messages.some(message => ['aborted', 'cancelled'].includes(message.status ?? ''))) return 'aborted';
    return 'success';
}

function messageMarkdown(message: ConversationMessage, encode: TranscriptEncoder): string {
    if (message.role === 'assistant') return message.text;
    if (message.role === 'system') return encode(message.text, `${TRANSCRIPT_SYSTEM} ${encodeURIComponent(message.id)}`);
    const name = (message.name ?? t('harness.roleTool')).replace(/[\r\n]/g, ' ');
    const operation = message.operation ? t(`harness.toolOperation.${message.operation}`) : '';
    const details = [message.commandPreview, ...(message.paths ?? [])].filter((text): text is string => Boolean(text))
        .map(text => text.replace(/[\r\n]/g, ' '));
    return encode([name + (operation ? ' · ' + operation : ''), ...details].join('\n'), `${TRANSCRIPT_TOOL} ${encodeURIComponent(message.id)}`);
}
