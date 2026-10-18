import { checkOperation, operationScope, FSError, type OperationOptions } from '@itookit/vfs-core';
import type { ProjectService, ProjectSearchQuery, ProjectSearchResult, ProjectSearchMatch } from '@itookit/app-contracts/services';
import { mapConcurrent } from '../utils/map-concurrent';

/** Delegate parsed native history search to the authorized source, never a host shell. */
export async function searchNativeSessions(remote: NonNullable<ProjectService['remoteMounts']>, folder: string, projectId: string,
    query: ProjectSearchQuery, options: OperationOptions): Promise<ProjectSearchResult> {
    const fingerprint = JSON.stringify(remote.list(projectId)), client = await remote.projectHarness(projectId, options);
    const request = operationScope({timeoutMs: 18_000}, options.signal);
    try {
        const profiles = (await client.profiles(request.options)).profiles.filter(profile => profile.projectRuntime
            && (!query.profileId || profile.id === query.profileId || profile.aliases?.includes(query.profileId)));
        if (!client.search || !profiles.length) throw new FSError('ECAPABILITY', 'Native session search unavailable');
        // Share the query deadline; do not divide the server's scan budget by the number of profiles.
        const results = await mapConcurrent(profiles, 2, async profile => {
            checkOperation(options);
            if (request.options.signal?.aborted || !profile.capabilities.search || query.scope === 'session-prompt' && !profile.capabilities.searchPrompts) return undefined;
            try {
                return await client.search!(profile.id, {query: query.query, mode: query.scope === 'session-title' ? 'title' : query.scope === 'session-prompt' ? 'prompt' : 'content', archived: query.archived}, request.options);
            } catch { checkOperation(options); return undefined; }
        });
        checkOperation(options);
        if (fingerprint !== JSON.stringify(remote.list(projectId))) throw new FSError('ECONFLICT', 'Project authorization changed');
        const unavailableSources = profiles.filter((_, index) => !results[index]).map(profile => profile.id);
        if (unavailableSources.length === profiles.length) throw new FSError('ECAPABILITY', 'Native session search unavailable');
        const matches: ProjectSearchMatch[] = results.flatMap((result, index) => result?.matches.map(row => ({...row, kind: 'remote-session' as const,
            projectId, folder, profileId: profiles[index].id, bindingIdentity: fingerprint, archived: query.archived})) ?? []);
        const truncated = matches.length > 100 || results.some(result => result?.truncated);
        return {matches: matches.slice(0, 100), truncated: truncated || unavailableSources.length > 0, nextCursor: null,
            ...(unavailableSources.length ? {unavailableSources} : {})};
    } finally { request.dispose(); await client.close(); }
}
