import { checkOperation, operationScope, FSError, type OperationOptions } from '@itookit/vfs-core';
import type { ProjectService, ProjectSearchQuery, ProjectSearchResult, ProjectSearchMatch } from '@itookit/app-contracts/services';

/** Delegate parsed native history search to the authorized source, never a host shell. */
export async function searchNativeSessions(remote: NonNullable<ProjectService['remoteMounts']>, folder: string, projectId: string,
    query: ProjectSearchQuery, options: OperationOptions): Promise<ProjectSearchResult> {
    const fingerprint = JSON.stringify(remote.list(projectId)), client = await remote.projectHarness(projectId, options);
    try {
        const profiles = (await client.profiles(options)).profiles.filter(profile => profile.projectRuntime
            && (!query.profileId || profile.id === query.profileId || profile.aliases?.includes(query.profileId)));
        if (!client.search || !profiles.length) throw new FSError('ECAPABILITY', 'Native session search unavailable');
        const matches: ProjectSearchMatch[] = [], unavailableSources: string[] = []; let truncated = false;
        for (const profile of profiles) {
            checkOperation(options);
            if (!profile.capabilities.search || query.scope === 'session-prompt' && !profile.capabilities.searchPrompts) { unavailableSources.push(profile.id); continue; }
            const request = operationScope({timeoutMs: Math.max(100, Math.floor(18_000 / profiles.length))}, options.signal);
            try {
                const result = await client.search(profile.id, {query: query.query, mode: query.scope === 'session-title' ? 'title' : query.scope === 'session-prompt' ? 'prompt' : 'content', archived: query.archived}, request.options);
                matches.push(...result.matches.map(row => ({...row, kind: 'remote-session' as const, projectId, folder, profileId: profile.id, bindingIdentity: fingerprint, archived: query.archived})));
                truncated ||= result.truncated;
            } catch { checkOperation(options); unavailableSources.push(profile.id); } finally { request.dispose(); }
            if (matches.length >= 100) { truncated = true; break; }
        }
        checkOperation(options);
        if (fingerprint !== JSON.stringify(remote.list(projectId))) throw new FSError('ECONFLICT', 'Project authorization changed');
        if (unavailableSources.length === profiles.length) throw new FSError('ECAPABILITY', 'Native session search unavailable');
        return {matches: matches.slice(0, 100), truncated: truncated || unavailableSources.length > 0, nextCursor: null,
            ...(unavailableSources.length ? {unavailableSources} : {})};
    } finally { await client.close(); }
}
