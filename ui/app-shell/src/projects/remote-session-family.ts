import type { LocalBackendPort } from '@itookit/app-contracts/services';
import { t } from '@itookit/common';
import { remoteSessionPath } from '@itookit/app-contracts';
import type { ProjectService } from '@itookit/app-contracts/services';

export async function showRemoteSessionFamily(conversationBranches: LocalBackendPort['conversationBranches'], projects: ProjectService, target: {folder: string; profileId?: string; nativeSessionId?: string}, signal: AbortSignal,
    open: (path: string) => Promise<void>): Promise<void> {
    const lifetime = new AbortController(), dialog = document.createElement('dialog');
    dialog.className = 'harness-control'; const abort = () => close(); signal.addEventListener('abort', abort, {once: true});
    const close = () => { lifetime.abort(); dialog.close(); dialog.remove(); signal.removeEventListener('abort', abort); };
    dialog.addEventListener('close', close, {once: true}); dialog.addEventListener('cancel', close, {once: true});
    const heading = document.createElement('h2'); heading.textContent = t('harness.family');
    const body = document.createElement('div'); body.textContent = t('project.search.loading');
    const button = document.createElement('button'); button.type = 'button'; button.textContent = t('harness.close'); button.onclick = close;
    dialog.append(heading, body, button); document.body.append(dialog); dialog.showModal();
    const timeout = setTimeout(() => lifetime.abort(), 20_000);
    let client: import('@itookit/piagent-driver').HarnessClient | undefined;
    try {
        const project = await projects.forFolder(target.folder);
        if (!project || !target.profileId || !target.nativeSessionId || signal.aborted) { close(); return; }
        client = await projects.remoteMounts!.projectHarness(project.project.id, {signal: lifetime.signal, timeoutMs: 3000});
        if (!client.inspect) throw new Error(t('project.search.unsupported'));
        const current = (await client.inspect(target.profileId, target.nativeSessionId, {signal: lifetime.signal, timeoutMs: 3000})).session;
        const family = await conversationBranches(client, target.profileId, current, {signal: lifetime.signal, timeoutMs: 3000});
        if (!lifetime.signal.aborted) body.replaceChildren(...family.map(session => {
            const link = document.createElement('button'); link.type = 'button'; link.textContent = session.title + (session.branchName ? ` · ${session.branchName}` : '');
            link.onclick = () => { void open(remoteSessionPath(target.folder, target.profileId, session.id)).then(close,
                () => { body.textContent = t('project.search.navigateFailed'); }); }; return link;
        }));
    } catch (error) { if (dialog.isConnected) body.textContent = error instanceof Error ? error.message : t('project.search.unavailable'); }
    finally { clearTimeout(timeout); await client?.close(); }
}
