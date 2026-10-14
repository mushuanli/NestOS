import type { ChatMessage } from '../domain/message';
import type { BranchContextProfile } from '../domain/context';

export interface ContextRoundSource {
    input: ChatMessage[];
    output: ChatMessage[];
    historyParentIds: string[];
    defaultContextMode?: 'include' | 'exclude';
    _deleted?: boolean;
}

export async function collectContextLineage(head: string | null, read: (id: string) => Promise<ContextRoundSource | null>) {
    const rounds: Array<{ id: string; round: ContextRoundSource }> = [];
    const visited = new Set<string>();
    let current: string | undefined = head ?? undefined;
    while (current) {
        if (visited.has(current)) throw new Error(`Conversation lineage cycle at ${current}`);
        visited.add(current);
        const round = await read(current);
        if (!round) throw new Error(`Conversation round not found: ${current}`);
        if (!round._deleted) rounds.push({ id: current, round });
        current = round.historyParentIds[0];
    }
    return rounds.reverse();
}

/** Legacy history projection. Summary artifact materialization belongs to the assembler. */
export async function foldContextHistory(head: string, read: (id: string) => Promise<ContextRoundSource | null>, profile: BranchContextProfile | null): Promise<ChatMessage[]> {
    const rounds = await collectContextLineage(head, read);
    return rounds.flatMap(({ id, round }) => {
        const rule = profile?.rules[id];
        if (rule ? rule.mode === 'exclude' : round.defaultContextMode === 'exclude') return [];
        return [...round.input, ...round.output].filter(message => message.role !== 'assistant'
            || typeof message.content !== 'string' || message.content.trim() || message.tool_calls?.length);
    });
}
