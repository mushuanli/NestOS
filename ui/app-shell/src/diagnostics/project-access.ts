import {t} from '@itookit/common';
import type {RemoteProjectStatus} from '@itookit/app-contracts/services';

type Mount = RemoteProjectStatus['mounts'][number];
export interface ProjectAccessDraft {mode?: 'ro' | 'rw'; execute?: boolean; config?: string; open?: boolean}
export interface ProjectAccessActions {configureConnection?(id: string): Promise<void>; remount?(): Promise<void>}

export function renderProjectAccess(mount: Mount, actions: ProjectAccessActions, closed: () => boolean, draft: ProjectAccessDraft = {}): HTMLElement {
    const section = document.createElement('section'); section.className = 'diagnostic-access';
    const title = document.createElement('h3'); title.textContent = t('diagnostics.access.title'); section.append(title);
    const info = document.createElement('dl'); info.className = 'diagnostic-access__fields'; section.append(info);
    const field = (key: Parameters<typeof t>[0], value?: string | number) => {
        const label = document.createElement('dt'), text = document.createElement('dd'); label.textContent = t(key); text.textContent = String(value ?? t('diagnostics.access.unknown')); info.append(label, text);
    };
    field('diagnostics.access.connection', mount.connectionName ?? mount.connectionId); field('diagnostics.access.identity', mount.principalId);
    field('diagnostics.access.protocol', mount.protocol ? t(`mcp.state.${mount.protocol.status}`) : undefined);
    field('diagnostics.access.protocolVersion', mount.protocolVersion); field('diagnostics.access.fileProtocol', mount.fileProtocol); field('diagnostics.access.projectProtocol', mount.projectProtocol);
    field('diagnostics.access.authentication', t(mount.authorization?.authentication === 'accepted' ? 'diagnostics.access.authAccepted' : 'diagnostics.access.unknown'));
    field('diagnostics.access.boundIdentity', mount.boundPrincipalId); field('diagnostics.access.export', mount.alias);
    field('diagnostics.access.path', mount.root); field('diagnostics.access.server', mount.serverId); field('diagnostics.access.project', mount.serverProjectId);
    field('diagnostics.access.localMode', accessText(mount.access)); field('diagnostics.access.serverMode', accessText(mount.authorization?.exportAccess));
    field('diagnostics.access.projectMode', accessText(mount.authorization?.projectAccess)); field('diagnostics.access.projectRevision', mount.boundProjectRevision);
    field('diagnostics.access.currentProjectRevision', mount.authorization?.projectRevision);
    field('diagnostics.access.boundRevision', mount.boundAuthorizationRevision); field('diagnostics.access.currentRevision', mount.authorizationRevision);
    const reason = mount.authorization?.reason ?? (mount.authorizationChanged ? 'binding-outdated' : 'unverified');
    const hint = document.createElement('p'); hint.textContent = t(`diagnostics.access.reason.${reason}`); section.append(hint);
    const revisionHint = document.createElement('p'); revisionHint.textContent = t('diagnostics.access.revisionHint'); section.append(revisionHint);
    renderCapabilities(section, mount);
    const controls = document.createElement('div'); controls.className = 'diagnostic-log__controls'; section.append(controls);
    if (mount.connectionId && actions.configureConnection) button(controls, t('diagnostics.access.configureMCP'), () => actions.configureConnection!(mount.connectionId!), closed);
    if (actions.remount) button(controls, t('remote.remountAs'), actions.remount, closed);
    if (mount.alias && mount.principalId) section.append(grantGuide(mount, closed, draft));
    return section;
}
function renderCapabilities(parent: HTMLElement, mount: Mount): void {
    const caps = mount.authorization?.capabilities;
    const table = document.createElement('table'); table.className = 'diagnostic-access__permissions';
    const caption = document.createElement('caption'); caption.textContent = t('diagnostics.access.permissions'); table.append(caption);
    for (const key of ['fileRead', 'fileWrite', 'run', 'sessionRead', 'sessionControl'] as const) {
        const row = document.createElement('tr'), name = document.createElement('th'), value = document.createElement('td');
        name.scope = 'row'; name.textContent = t(`diagnostics.access.permission.${key}`);
        const allowed = caps?.[key] ?? (mount.authorization?.exportAccess === 'none' ? false : undefined);
        value.textContent = t(allowed === undefined ? 'diagnostics.access.unknown' : allowed ? 'diagnostics.access.allowed' : 'diagnostics.access.denied');
        row.append(name, value); table.append(row);
    }
    parent.append(table);
}
function grantGuide(mount: Mount, closed: () => boolean, draft: ProjectAccessDraft): HTMLElement {
    const details = document.createElement('details'), title = document.createElement('summary'); title.textContent = t('diagnostics.access.serverGuide'); details.append(title); details.open = draft.open ?? mount.authorization?.exportAccess === 'none';
    details.ontoggle = () => {if (details.isConnected) draft.open = details.open;};
    const hint = document.createElement('p'); hint.textContent = t('diagnostics.access.serverGuideHint'); details.append(hint);
    const config = document.createElement('input'); config.type = 'text'; config.value = draft.config ?? '/path/to/config.toml'; config.setAttribute('aria-label', t('diagnostics.access.configPath'));
    const mode = document.createElement('select'), execute = document.createElement('input'), label = document.createElement('label'), command = document.createElement('pre');
    mode.setAttribute('aria-label', t('diagnostics.access.grantMode'));
    for (const access of ['ro', 'rw'] as const) {const option = document.createElement('option'); option.value = access; option.textContent = t(`remote.access.${access}`); mode.append(option);}
    mode.value = draft.mode ?? mount.access ?? 'ro'; execute.type = 'checkbox'; execute.checked = draft.execute ?? false; label.append(execute, document.createTextNode(t('diagnostics.access.grantExecution')));
    const valid = [mount.principalId, mount.alias].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
    if (!valid) return details;
    const update = () => {draft.mode = mode.value === 'rw' ? 'rw' : 'ro'; draft.execute = execute.checked; draft.config = config.value;
        command.textContent = `cells access --config ${shellPath(config.value)} grant ${mount.principalId} ${mount.alias} ${draft.mode}${execute.checked ? ' --execute' : ''}`;};
    mode.onchange = execute.onchange = config.oninput = update; update(); details.append(config, mode, label, command);
    button(details, t('diagnostics.access.copyGrant'), async () => {
        try {await navigator.clipboard.writeText(command.textContent ?? ''); if (!closed()) hint.textContent = t('diagnostics.copied');}
        catch {if (!closed()) hint.textContent = t('diagnostics.copyFailed');}
    }, closed);
    return details;
}
function button(parent: HTMLElement, label: string, action: () => Promise<void>, closed: () => boolean): void {
    const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
    element.onclick = async () => {if (element.disabled) return; element.disabled = true;
        try {await action();} catch {if (!closed()) {const error = document.createElement('p'); error.setAttribute('role', 'alert'); error.textContent = t('diagnostics.access.actionFailed'); parent.append(error);}}
        finally {if (!closed()) element.disabled = false;}
    }; parent.append(element);
}

function accessText(value?: string): string {
    const mode = (['none', 'denied', 'ro', 'rw'] as const).find(mode => mode === value) ?? 'unknown';
    return t(`diagnostics.access.mode.${mode}`);
}

function shellPath(value: string): string {
    return /^[a-zA-Z0-9_./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
}
