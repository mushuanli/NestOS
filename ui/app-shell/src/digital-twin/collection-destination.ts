import {escapeAttr, escapeHTML} from '@itookit/common';
import {TWIN_COLLECTION_WORKSPACES, workspaceRoot, type TwinCollectionExecutor, type TwinCollectionWorkspace} from '@itookit/app-contracts';
import {label} from './view';
export interface CollectionProject {id: string; name: string}
export function collectionDestinationFields(selected?: TwinCollectionExecutor, projects: CollectionProject[] = []): string {
    const projectOptions = [...projects];
    if (selected?.projectId && !projectOptions.some(project => project.id === selected.projectId)) projectOptions.push({id: selected.projectId, name: label('scannerTargetUnavailable')});
    return `<div data-collection-destination${selected?.target.kind === 'tool' ? '' : ' hidden'}><label>${escapeHTML(label('collectionDestination'))}<select name="collectionDestination">
        <option value="">${escapeHTML(label('collectionDestination.project'))}</option>
        ${TWIN_COLLECTION_WORKSPACES.map(id => `<option value="${id}"${selected?.destination === id ? ' selected' : ''}>${escapeHTML(label('collectionDestination.' + id))}</option>`).join('')}
        ${projectOptions.map(project => `<option value="project:${escapeAttr(project.id)}"${selected?.projectId === project.id ? ' selected' : ''}>${escapeHTML(label('collectionProject'))} · ${escapeHTML(project.name)}</option>`).join('')}</select></label>
        <label>${escapeHTML(label('collectionDirectory'))}<input name="collectionDirectory" value="${escapeAttr(selected?.directory ?? '')}" placeholder="${escapeAttr(label('collectionDirectoryPlaceholder'))}"></label>
        <p class="twin__help">${escapeHTML(label('collectionDestinationHelp'))}</p></div>`;
}
export function readCollectionDestination(form: HTMLFormElement): Pick<TwinCollectionExecutor, 'destination' | 'projectId' | 'directory'> {
    const destination = form.querySelector<HTMLSelectElement>('[name=collectionDestination]')?.value;
    const directory = form.querySelector<HTMLInputElement>('[name=collectionDirectory]')?.value.trim();
    if (!destination && directory) throw new Error(label('collectionDestinationInvalid'));
    if (!destination) return {};
    if (destination.startsWith('project:')) return {projectId: destination.slice(8), ...(directory ? {directory} : {})};
    if (!TWIN_COLLECTION_WORKSPACES.includes(destination as TwinCollectionWorkspace)) throw new Error(label('collectionDestinationInvalid'));
    return {destination: destination as TwinCollectionWorkspace, ...(directory ? {directory} : {})};
}
export function collectionDestinationSummary(collection?: TwinCollectionExecutor): string {
    if (!collection) return '';
    const root = collection.destination ? workspaceRoot(collection.destination) : collection.projectId ? label('collectionProject') + ' · ' + collection.projectId : label('collectionDestination.project');
    const destination = root + (collection.directory ? '/' + collection.directory : '');
    return `<p>${escapeHTML(label('collectionDestination'))}: <span data-collection-location="${escapeAttr(destination)}">${escapeHTML(destination)}</span></p>`;
}
