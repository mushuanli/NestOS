import { FSError } from '@itookit/vfs-core';
import type { HarnessClient, HarnessHistory } from '@itookit/piagent-driver';
import type { ProjectService, ProjectFolder } from '../projects/project-service';
import type { TwinSourceCatalog, TwinSourceContent } from './domain';
import { sha256HexSync } from '@itookit/llm-context';

export const harnessTarget = (project: string, profile: string, session: string) => JSON.stringify([project, profile, session]);
export async function discoverHarness(projects: ProjectService, project: ProjectFolder, catalog: TwinSourceCatalog): Promise<void> {
    if (!projects.remoteMounts?.list(project.project.id).some(mount => mount.at === '/' && mount.connectionId && mount.serverProjectId)) return;
    let client: HarnessClient | undefined;
    try {
        client = await projects.remoteMounts.projectHarness(project.project.id, { timeoutMs: 5000 });
        const resources: TwinSourceCatalog['resources'] = [];
        for (const profile of (await client.profiles({ timeoutMs: 5000 })).profiles.filter(item => item.capabilities.history && item.projectRuntime)) {
            for (const archived of [false, true]) {
                let cursor: string | undefined; const seen = new Set<string>();
                do {
                    const page = await client.list(profile.id, { archived, cursor }, { timeoutMs: 5000 });
                    for (const session of page.sessions) resources.push({ kind: 'harness-session', projectId: project.project.id, projectName: project.name, profileId: profile.id,
                        sessionId: session.id, target: harnessTarget(project.project.id, profile.id, session.id), label: session.title, version: String(session.updatedAt) });
                    if (resources.length > 10000 || (page.nextCursor && seen.has(page.nextCursor))) throw new Error('TWIN_SOURCE_LIMIT');
                    cursor = page.nextCursor ?? undefined; if (cursor) seen.add(cursor);
                } while (cursor);
            }
        }
        catalog.resources.push(...resources); catalog.completeScopes.push(`${project.project.id}/harness-session`);
    } catch { catalog.errors.push(`${project.project.id}/harness-session`); }
    finally { await client?.close(); }
}
export async function readHarness(projects: ProjectService, target: string): Promise<TwinSourceContent> {
    const [projectId, profileId, sessionId] = parseTarget(target);
    const client = await projects.remoteMounts?.projectHarness(projectId, { timeoutMs: 5000 });
    if (!client) throw new FSError('ENOENT', 'Harness project missing');
    try {
        const root = projects.remoteMounts?.list(projectId).find(mount => mount.at === '/');
        const binding = [root?.connectionId, root?.serverId, root?.serverProjectId];
        const texts: string[] = [], seen = new Set<string>(); let cursor: string | undefined, identity = '', nativeIdentity = '', bytes = 0;
        do {
            const history = await client.read(profileId, sessionId, { cursor, timeoutMs: 5000, toolDetail: 'summary' });
            if (history.session.activeTurnId || !['idle', 'notLoaded', null].includes(history.session.status)) throw new Error('TWIN_SOURCE_BUSY');
            const current = JSON.stringify([binding, projectId, profileId, sessionId, history.session.createdAt, history.session.updatedAt]);
            if (identity && identity !== current) throw new Error('TWIN_SOURCE_CHANGED'); identity = current;
            nativeIdentity = JSON.stringify([binding, projectId, profileId, sessionId, history.session.createdAt]);
            const text = publicHarnessText(history); bytes += new TextEncoder().encode(text).length; texts.push(text);
            if (bytes > 1024 * 1024 || (history.nextCursor && seen.has(history.nextCursor))) throw new Error('TWIN_SOURCE_LIMIT');
            cursor = history.nextCursor ?? undefined; if (cursor) seen.add(cursor);
        } while (cursor);
        const text = texts.join('\n'); return { text, hash: sha256HexSync(text), nativeIdentity };
    } finally { await client.close(); }
}
function parseTarget(target: string): [string, string, string] {
    const value: unknown = JSON.parse(target);
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== 'string' || !item)) throw new Error('TWIN_INVALID_SOURCE');
    return value as [string, string, string];
}
export function publicHarnessText(history: HarnessHistory): string {
    if (history.turns === null) throw new Error('TWIN_HISTORY_INCOMPLETE');
    return JSON.stringify(history.turns.flatMap(turn => {
        const row = turn as { id?: string; items?: Array<{ type?: string; id?: string; text?: string; content?: unknown }> };
        return (row.items ?? []).filter(item => ['userMessage', 'agentMessage'].includes(item.type ?? '')).map(item => ({
            id: item.id, turn: row.id, role: item.type === 'userMessage' ? 'user' : 'assistant',
            content: typeof item.text === 'string' ? item.text : visibleText(item.content),
        }));
    }));
}
function visibleText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(item => item && ['text', 'input_text', 'output_text'].includes(item.type) && typeof item.text === 'string').map(item => item.text).join('\n');
}
