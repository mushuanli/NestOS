import {verifyCommitContexts} from './kanban-commit-context';
import {developmentStage} from './kanban-development-log';
import {failure} from '../run/prompt-bundle';
import type {RepositoryEvidence} from '../projects/worktree-modules';
import type {IFileSystem} from '@itookit/vfs-core';
import type {ProjectRemoteMountService, RemoteFileSourceProvider} from '../projects/remote-mounts';
import {verifyWorktreeDelivery} from '../projects/worktree-modules';
import {KanbanAutomationJournal} from '../kanban/automation-journal';
import {developmentWorkspace} from './kanban-development-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';

export function developmentDelivery(fs: IFileSystem, remote: ProjectRemoteMountService, provider: RemoteFileSourceProvider) {
    const journal = new KanbanAutomationJournal(fs);
    return async (dispatchId: string) => {
        const record = await journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + dispatchId);
        if (!record) return;
        const repositories = await developmentStage(dispatchId, 'delivery.verify', () => developmentWorkspace(remote, provider, record.projectId,
            async process => {
                const evidence = await verifyWorktreeDelivery(process, record.directory, record.repositories, record.policy.commit, record.availableRepositories);
                if (record.commitContext && record.policy.commit === 'worktree') {
                    const commits = await verifyCommitContexts(process, record.directory, evidence, record.commitContext);
                    await journal.update('development-commits:' + dispatchId, old => old ?? {contextDigest: record.commitContext!.digest, repositories: commits});
                }
                return evidence;
            }));
        await journal.update<{verifiedAt: number; commit: string; repositories: RepositoryEvidence[]}>('development-delivery:' + dispatchId, old => {
            if (old && JSON.stringify(old.repositories) !== JSON.stringify(repositories)) throw failure('DELIVERY_CHANGED_AFTER_VERIFICATION');
            return old ?? {verifiedAt: Date.now(), commit: record.policy.commit, repositories};
        });
    };
}
