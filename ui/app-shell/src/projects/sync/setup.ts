import { t } from '@itookit/common';
import { SyncDialog, paragraph } from './dialog';
import { directionSelect } from './controls';

export interface ProjectSyncSetupPorts {
    connections(): { id: string; name: string }[];
    inspect(connectionId: string): Promise<{ projectId: string }[]>;
    bind(connectionId: string, projectId: string, create: boolean, direction?: 'both' | 'upload' | 'download'): Promise<void>;
}

/** The host resolves credentials and persistence; the view only selects identities. */
export function showProjectSyncSetup(ports: ProjectSyncSetupPorts, suggestedId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => mountSetup(ports, suggestedId, signal, resolve));
}
function mountSetup(ports: ProjectSyncSetupPorts, suggestedId: string, signal: AbortSignal, closed: () => void): void {
    const dialog = new SyncDialog(t('project.sync.setup'), signal, closed);
    const connection = select(dialog.body, 'remote.connection', ports.connections().map(c => [c.id, c.name]));
    const project = select(dialog.body, 'project.sync.cloudProject', []);
    const name = document.createElement('input'); name.value = suggestedId; name.setAttribute('aria-label', t('project.sync.newCloudProject'));
    const label = document.createElement('label'); label.textContent = t('project.sync.newCloudProject'); label.append(name); dialog.body.append(label);
    paragraph(dialog.body, t('project.sync.bindHint'));
    const direction = directionSelect(dialog.body, 'both');
    if (!connection.options.length) paragraph(dialog.body, t('remote.connectionEmpty'));
    const load = installActions(dialog, ports, connection, project, name, direction, signal);
    project.onchange = () => { label.hidden = !!project.value; };
    dialog.open();
    if (connection.value) void dialog.run(load, true);
}
function installActions(dialog: SyncDialog, ports: ProjectSyncSetupPorts, connection: HTMLSelectElement,
    project: HTMLSelectElement, name: HTMLInputElement, direction: HTMLSelectElement, signal: AbortSignal): () => Promise<void> {
    let inspected: string | undefined;
    const bind = dialog.button(t('project.sync.bindConfirm'), async () => {
        if (!inspected || inspected !== connection.value) throw new Error(t('project.sync.inspectFirst'));
        const create = !project.value, id = create ? name.value.trim() : project.value;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error(t('project.sync.invalidDirectory'));
        await ports.bind(inspected, id, create, direction.value as 'both' | 'upload' | 'download'); dialog.close();
    });
    const inspect = async () => {
        const id = connection.value, items = await ports.inspect(id);
        if (signal.aborted || id !== connection.value) return;
        project.replaceChildren(); addOption(project, '', t('project.sync.createCloudProject'));
        for (const item of items) addOption(project, item.projectId, item.projectId);
        project.dispatchEvent(new Event('change'));
        inspected = id; bind.dataset.unavailable = 'false'; dialog.message(t('project.sync.serverReady'));
    };
    const load = dialog.button(t('project.sync.loadProjects'), inspect, true);
    bind.disabled = true; bind.dataset.unavailable = 'true'; load.disabled = !connection.value; load.dataset.unavailable = String(!connection.value);
    connection.onchange = () => {
        inspected = undefined; project.replaceChildren(); project.dispatchEvent(new Event('change'));
        bind.disabled = true; bind.dataset.unavailable = 'true'; void dialog.run(inspect, true);
    };
    return inspect;
}
function select(parent: HTMLElement, key: Parameters<typeof t>[0], items: [string, string][]): HTMLSelectElement {
    const label = document.createElement('label'); label.textContent = t(key);
    const element = document.createElement('select'); element.setAttribute('aria-label', t(key));
    for (const [id, name] of items) addOption(element, id, name);
    label.append(element); parent.append(label); return element;
}
function addOption(select: HTMLSelectElement, value: string, text: string): void {
    const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
}
