import type { ISessionRepository } from '../persistence/types';
import { RoundLog } from '../persistence/round-log';

/** Resolve membership from persisted Round lineage, never from the Session-wide Task list. */
export async function flowBranchExecutions(repository: ISessionRepository, sessionId: string) {
    const log = new RoundLog(repository, sessionId), manifest = await log.loadManifest();
    const branches = await Promise.all(Object.entries(manifest.branches).map(async ([name, head]) => {
        const runs: Array<{ taskId: string; flowId: string; revision: number; roundId: string }> = [];
        const pending = head ? [head] : [], visited = new Set<string>(), taskIds = new Set<string>();
        while (pending.length) {
            const id = pending.pop()!;
            if (visited.has(id)) continue;
            visited.add(id);
            const round = await log.readRound(id);
            if (!round || round._deleted) continue;
            for (const execution of round.executions) {
                taskIds.add(execution.taskId);
                if (round.flow) runs.push({ taskId: execution.taskId, flowId: round.flow.flowId, revision: round.flow.revision, roundId: round.id });
            }
            pending.push(...round.historyParentIds);
        }
        return { name, taskIds: [...taskIds], runs };
    }));
    return { sessionId, currentBranch: manifest.currentBranch, branches };
}
