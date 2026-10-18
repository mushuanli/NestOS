import {FSError, type IFileSystem} from '@itookit/vfs-core';

export interface NativeConversationIdentity {
    connectionId: string;
    serverProjectId: string;
    principalId?: string;
    profileId: string;
    nativeSessionId: string;
}

/** Native IDs are scoped to the authorized project and executor. */
export function nativeIdentityKey(identity: NativeConversationIdentity): string {
    return 'native/' + JSON.stringify([identity.connectionId, identity.serverProjectId, identity.principalId ?? null,
        identity.profileId, identity.nativeSessionId]);
}

export async function readConversationIdentity(fs: IFileSystem, projectId: string, identity: NativeConversationIdentity): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new FSError('EINVAL', 'Invalid project identity');
    try {return await fs.meta.seq!.getEntry(`/var/lib/projects/${projectId}/draft.seq`, nativeIdentityKey(identity)) ?? undefined;}
    catch (error) {if (!(error instanceof FSError) || error.code !== 'ENOENT') throw error;}
}
