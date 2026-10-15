import { FSError, type FileSystemContextOwner } from '@itookit/vfs-core';
import { SessionCommand, type SessionSnapshot } from '@itookit/llm-session/contracts';
import type { LocalApplicationServices, SessionEditorInitialData, SessionOpenView } from '@itookit/app-contracts/services';

/** Preparation may fail without replacing the editor's current binding. */
export async function openSessionView(services: LocalApplicationServices, sessionId: string): Promise<SessionOpenView> {
    await services.prepareSession?.(sessionId);
    const manifest = await services.sessionRepository.getManifest(sessionId);
    const [project, fixed] = await Promise.all([
        services.projects?.forFolder(manifest.folder), services.directoryMounts?.fixedWorkspace(sessionId),
    ]);
    const owner = await services.sessionFiles.acquireFiles(sessionId);
    return { manifest, project, workspaceReadOnly: fixed !== undefined, context: owner.context, ...activationLease(services, sessionId, owner) };
}

function activationLease(services: LocalApplicationServices, sessionId: string, owner: FileSystemContextOwner): Pick<SessionOpenView, 'activate' | 'dispose'> {
    let closed = false;
    const activations = new Set<Promise<SessionEditorInitialData>>();
    return {
        activate: async branch => {
            if (closed) throw new FSError('EIO', 'Session view is closed');
            const pending = activateSession(services, sessionId, branch); activations.add(pending);
            try {
                const initial = await pending;
                if (closed) throw new FSError('EIO', 'Session view is closed');
                return initial;
            } finally { activations.delete(pending); }
        },
        dispose: async () => { closed = true; await Promise.allSettled(activations); await owner.release(); },
    };
}

/** Binding is deferred until the previous editor has saved and released its binding. */
async function activateSession(services: LocalApplicationServices, sessionId: string, branch?: string): Promise<SessionEditorInitialData> {
    let snapshot = await services.commandBus.execute<SessionSnapshot>(SessionCommand.Bind, { sessionId });
    if (branch !== undefined && snapshot.view?.manifest.currentBranch !== branch) {
        await services.commandBus.execute('vcs.branch.switch', { branchName: branch });
        snapshot = await services.commandBus.execute<SessionSnapshot>(SessionCommand.GetSnapshot);
    }
    const loaded = snapshot.view ?? (services.sessionRepository.getLoadState
        ? await services.sessionRepository.getLoadState(sessionId)
        : { manifest: await services.sessionRepository.getManifest(sessionId),
            settings: await services.commandBus.execute<SessionEditorInitialData['settings']>(SessionCommand.GetSettings) });
    return { sessionId, snapshot, ...loaded, title: loaded.manifest.title };
}
