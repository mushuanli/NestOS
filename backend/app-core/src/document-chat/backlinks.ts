import {FSError} from '@itookit/vfs-core';
import type {LocalApplicationServices} from '@itookit/app-contracts/services';
import {DocumentChatRegistry} from './registry';

/** Branch backlinks query the canonical reverse index, never a second independently edited list. */
export async function documentChatBacklinks(services: LocalApplicationServices, sessionId: string, branch: string) {
    const registry = new DocumentChatRegistry(services);
    return registry.serialize(async () => {
        const links = await registry.branch(sessionId, branch);
        if (!links.length) return [];
        let exists = false;
        try {exists = Object.hasOwn((await services.sessionRepository.getManifest(sessionId)).branches, branch);}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'ENOENT') throw error;}
        if (exists) return links;
        for (const link of links) await registry.save({...link, status: 'missing', endpoint: undefined, projectionPending: true}, link);
        return [];
    });
}
