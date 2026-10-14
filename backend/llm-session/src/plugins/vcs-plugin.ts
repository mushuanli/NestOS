// vcs-plugin — VCS commands backed by Log.refs() operations.
//
// Branch management: create / switch / rename / delete / list / tree / messages.
// All operations delegate to SessionManager which wraps the SessionRepository.

import type { ILLMPlugin, ExtensionContext } from '../contracts';
import type { SessionManager } from '../session/session-manager';

export function createVcsPlugin(sessionManager: SessionManager): ILLMPlugin {
    return {
        name: 'vcs',
        activate(ctx: ExtensionContext): void {
            const sm = sessionManager;

            ctx.commands.register('vcs.branch.create', async (args) => {
                const { branchNodeId, options } = args as { branchNodeId: string; options?: { name?: string; copyContent?: boolean } };
                return sm.createBranch(branchNodeId, options);
            });
            ctx.commands.register('vcs.branch.switch', async (args) => {
                const { branchName } = args as { branchName: string };
                return sm.switchBranch(branchName);
            });
            ctx.commands.register('vcs.branch.tree', async () => sm.getBranchTree());
            ctx.commands.register('vcs.branch.rename', async (args) => {
                const { oldName, newName } = args as { oldName: string; newName: string };
                return sm.renameBranch(oldName, newName);
            });
            ctx.commands.register('vcs.branch.delete', async (args) => {
                const { branchName } = args as { branchName: string };
                return sm.deleteBranch(branchName);
            });
            ctx.commands.register('vcs.branch.list', async () => sm.listBranches());
            ctx.commands.register('vcs.branch.messages', async (args) => {
                const { branchHeadNodeId } = args as { branchHeadNodeId: string };
                return sm.getBranchMessages(branchHeadNodeId);
            });
        },
    };
}
