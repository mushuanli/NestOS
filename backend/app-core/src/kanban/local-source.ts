import type {SessionRepository} from '@itookit/llm-session';
import type {ChatMessage} from '@itookit/llm-context';
import type {KanbanScanSession, KanbanScanText} from '@itookit/kanban/contracts';
import type {KanbanScanSource} from '@itookit/kanban/discovery';
import {requireValue} from './validation';

/** The host catalog supplies project membership, archive policy and authoritative queue/Task activity. */
export function createLocalKanbanSource(options: {
    projectId: string; repository: Pick<SessionRepository, 'readHistoryChain'>;
    list(includeArchived: boolean): Promise<KanbanScanSession[]>;
    inspect(sessionId: string): Promise<KanbanScanSession>;
}): KanbanScanSource {
    return {projectId: options.projectId, kind: 'local', list: options.list, inspect: options.inspect,
        async read(source, maxBytes): Promise<KanbanScanText> {
            const chain = await options.repository.readHistoryChain(source.id), messages: KanbanScanText['messages'] = [];
            for (const round of chain.rounds) {
                requireValue(!['pending', 'running', 'waiting'].includes(round.status), 'SOURCE_NOT_SETTLED');
                if (!['user', 'edit'].includes(round.origin) || round.exposure === 'internal') continue;
                round.input.forEach((message, index) => {
                    if (message.role === 'user') messages.push({id: `${round.id}:user:${index}`, role: 'user', text: visibleText(message)});
                });
                round.output.forEach((message, index) => {
                    if (message.role === 'assistant') messages.push({id: `${round.id}:assistant:${index}`, role: 'assistant', text: visibleText(message)});
                });
            }
            const current = await options.inspect(source.id); requireValue(current.revision === source.revision && current.activity === 'idle', 'SOURCE_CHANGED');
            const text = {session: source, messages: messages.filter(m => m.text.trim()), complete: true};
            requireValue(new TextEncoder().encode(JSON.stringify(text)).length <= maxBytes, 'SCAN_INPUT_LIMIT'); return text;
        }};
}
function visibleText(message: ChatMessage): string {
    if (typeof message.content === 'string') return message.content;
    return message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}
