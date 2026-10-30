import type {Round} from './conversation';

/** Assistant text only: reasoning, tools, attachments and user messages stay separate. */
export function assistantResponseText(round: Pick<Round, 'output'>): string {
    return round.output.filter(message => message.role === 'assistant').map(message => typeof message.content === 'string'
        ? message.content : message.content.filter(part => part.type === 'text').map(part => 'text' in part ? part.text : '').join('')).join('\n').trim();
}
