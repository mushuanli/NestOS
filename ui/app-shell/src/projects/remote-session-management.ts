import type { NativeSessionCommand, ProjectService } from '@itookit/app-contracts/services';
import type { LocalBackendPort } from '@itookit/app-contracts/services';
import { t } from '@itookit/common';
import { showNameDialog } from '../files/project-dialog';

interface Target {folder: string; profileId?: string; nativeSessionId?: string; archived?: boolean}
export function nativeSessionMenu(manageRemoteSession: LocalBackendPort['manageRemoteSession'], projects: ProjectService, target: Target, title: string, capability: unknown, signal: AbortSignal,
    before: () => Promise<void>, changed: (command: NativeSessionCommand, title: string, deletedSessionIds: string[]) => Promise<void>, report: (error: unknown) => void) {
    if (!target.profileId || !target.nativeSessionId) return [];
    const caps = capability as {rename?: boolean; archive?: boolean; unarchive?: boolean; delete?: boolean; archiveDisabled?: boolean} | undefined;
    const save = async (command: NativeSessionCommand) => {
        await before();
        const result = await manageRemoteSession(projects, target.folder, target.profileId!, target.nativeSessionId!, command, {signal, timeoutMs: 20_000});
        await changed(command, result.title, result.deletedSessionIds ?? []);
    };
    const rename = () => showNameDialog(t('harness.rename'), t('harness.nativeTitle'), signal, name => save({kind: 'rename', name}), undefined,
        {initialName: title, confirmLabel: t('harness.rename')});
    const archived = !!target.archived;
    const archive = () => {
        const detail = document.createElement('p'); detail.textContent = t(archived ? 'harness.unarchiveEffect' : 'harness.archiveEffect');
        return showNameDialog(t(archived ? 'harness.unarchive' : 'harness.archive'), '', signal,
            () => save({kind: archived ? 'unarchive' : 'archive'}), detail, {hideName: true, confirmLabel: t(archived ? 'harness.unarchive' : 'harness.archive')});
    };
    const remove = () => {
        const detail = document.createElement('p'); detail.textContent = t('harness.deleteEffect');
        return showNameDialog(t('harness.delete'), '', signal, () => save({kind: 'delete'}), detail,
            {hideName: true, confirmLabel: t('harness.delete')});
    };
    return [
        ...(caps?.rename ? [{id: 'native-rename', label: t('harness.rename'), onClick: () => { void rename().catch(report); }}] : []),
        ...(caps?.delete ? [{id: 'native-delete', label: t('harness.delete'), onClick: () => { void remove().catch(report); }}] : []),
        ...(caps?.archive || caps?.unarchive ? [{id: 'native-archive', label: t(archived ? 'harness.unarchive' : caps.archiveDisabled ? 'harness.archiveUnavailable' : 'harness.archive'), disabled: !archived && caps.archiveDisabled, onClick: () => { void archive().catch(report); }}] : []),
    ];
}
