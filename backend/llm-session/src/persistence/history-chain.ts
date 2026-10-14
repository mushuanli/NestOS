import type { PersistedRound, RoundManifest } from './round-types';

export interface SessionHistoryChain {
    chain: string[];
    rounds: PersistedRound[];
    branch: string;
}

/** Read only the selected parent chain; unrelated branches and assets stay untouched. */
export async function collectHistoryChain(
    manifest: Pick<RoundManifest, 'currentHead' | 'currentBranch'>,
    readRound: (id: string) => Promise<PersistedRound | null>,
): Promise<SessionHistoryChain> {
    const chain: string[] = [], rounds: PersistedRound[] = [], visited = new Set<string>();
    let current: string | null | undefined = manifest.currentHead;
    while (current && !visited.has(current)) {
        visited.add(current);
        chain.push(current);
        const round = await readRound(current);
        if (round) rounds.push(round);
        current = round?.historyParentIds[0];
    }
    return { chain: chain.reverse(), rounds: rounds.reverse(), branch: manifest.currentBranch };
}

/** Preserve missing/corrupt-round tolerance for both individual and snapshot reads. */
export async function readRoundDocument(read: () => Promise<string | null>): Promise<PersistedRound | null> {
    try {
        const content = await read();
        return content ? JSON.parse(content) as PersistedRound : null;
    } catch { return null; }
}
