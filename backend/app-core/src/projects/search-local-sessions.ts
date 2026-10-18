import { checkOperation, FSError, type OperationOptions } from '@itookit/vfs-core';
import { folderBrowserPath } from '@itookit/app-contracts';
import type { ProjectSearchQuery, ProjectSearchMatch, ProjectSearchResult } from '@itookit/app-contracts/services';
import type { ISessionRepository, SessionSummary, SessionFolder, Round, ConversationManifest } from '@itookit/llm-session/contracts';

type SearchRound = Round & {_deleted?: boolean};
interface Budget { matches: ProjectSearchMatch[]; bytes: number; rounds: number; truncated: boolean }
const full = (budget: Budget) => budget.matches.length >= 100 || budget.bytes >= 16 * 1024 * 1024 || budget.rounds >= 2000;

/** Repository reads work across local/browser stores without a filesystem-specific search API. */
export async function searchLocalSessions(repository: ISessionRepository, folder: string, projectId: string,
    query: ProjectSearchQuery, options: OperationOptions): Promise<ProjectSearchResult> {
    const budget: Budget = {matches: [], bytes: 0, rounds: 0, truncated: false};
    if (query.archived) return {matches: [], truncated: false, nextCursor: null};
    const groups = projectGroups(folder, await repository.listFolders());
    const rows = repository.listSummariesInFolder && groups.length <= 16 ? (await Promise.all(groups.map(group => repository.listSummariesInFolder!(group)))).flat()
        : (await (repository.listSummaries?.() ?? repository.list())).filter(row => groups.includes(row.folder ?? ''));
    rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
    for (const [index, row] of rows.entries()) {
        checkOperation(options);
        if (full(budget) || index >= 2000) { budget.truncated = true; break; }
        if (query.scope === 'session-title') {
            if (row.title.toLowerCase().includes(query.query.toLowerCase())) budget.matches.push({...base(row, folder, projectId), summary: row.title});
        } else await searchHistory(repository, row, folder, projectId, query, budget, options);
    }
    checkOperation(options);
    return {matches: budget.matches, truncated: budget.truncated, nextCursor: null};
}
function projectGroups(folder: string, folders: SessionFolder[]): string[] {
    const inside = (path: string, root: string) => path === root || path.startsWith(root + '/');
    const nested = folders.filter(row => row.project && row.path !== folder && inside(row.path, folder));
    return [folder, ...folders.filter(row => row.path !== folder && inside(row.path, folder)
        && !nested.some(project => inside(row.path, project.path))).map(row => row.path)];
}
function base(row: SessionSummary, folder: string, projectId: string): Omit<ProjectSearchMatch, 'summary'> {
    return {kind: 'session', projectId, folder, sessionId: row.id, title: row.title, updatedAt: row.updatedAt,
        resourcePath: folderBrowserPath(row.folder ?? null) + '/' + row.id};
}
async function searchHistory(repository: ISessionRepository, row: SessionSummary, folder: string, projectId: string,
    query: ProjectSearchQuery, budget: Budget, options: OperationOptions): Promise<void> {
    const manifest = await repository.getManifest(row.id), seen = new Set<string>();
    if ((manifest.folder ?? null) !== (row.folder ?? null)) throw new FSError('ECONFLICT', 'Session project changed');
    const branches = [[manifest.currentBranch, manifest.currentHead], ...Object.entries(manifest.branches)] as Array<[string, string | null]>;
    for (const [branch, head] of branches) {
        let id = head;
        while (id && !seen.has(id)) {
            checkOperation(options);
            if (full(budget)) { budget.truncated = true; return; }
            seen.add(id); ++budget.rounds;
            const round = await readRound(repository, manifest, id, budget);
            if (!round) break;
            if (!round._deleted && round.exposure !== 'internal') recordRound(round, {...base(row, folder, projectId), branch}, query, budget);
            id = round.historyParentIds[0] ?? null;
        }
    }
    if ((await repository.getManifest(row.id)).folder !== manifest.folder) throw new FSError('ECONFLICT', 'Session project changed');
}
async function readRound(repository: ISessionRepository, manifest: ConversationManifest, id: string, budget: Budget): Promise<SearchRound | null> {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new FSError('EIO', 'Invalid history identity');
    const recordText = await repository.readDocument(manifest.id, `round-${id}.json`);
    if (!recordText) { budget.truncated = true; return null; }
    budget.bytes += recordText.length * 2;
    if (full(budget) || recordText.length > 2 * 1024 * 1024) { budget.truncated = true; return null; }
    const round = JSON.parse(recordText) as SearchRound;
    if (round.id !== id || !Array.isArray(round.input) || !Array.isArray(round.output) || !Array.isArray(round.historyParentIds)) throw new FSError('EIO', 'Invalid session history');
    return round;
}
function recordRound(round: SearchRound, base: Omit<ProjectSearchMatch, 'summary'>, query: ProjectSearchQuery, budget: Budget): void {
    const messages = query.scope === 'session-prompt' ? round.input.filter(message => message.role === 'user')
        : [...round.input, ...round.output].filter(message => message.role === 'user' || message.role === 'assistant');
    for (const message of messages) {
        const text = typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        const index = text.toLowerCase().indexOf(query.query.toLowerCase());
        if (index < 0) continue;
        budget.matches.push({...base, turnId: round.id, itemId: `round-${round.id}-${message.role}`, summary: text.slice(Math.max(0, index - 80), index + 420)});
        if (full(budget)) return;
    }
}
