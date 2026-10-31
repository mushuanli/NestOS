import {escapeAttr, escapeHTML} from '@itookit/common';
import {TWIN_COLLECTION_WORKSPACES, workspaceRoot, type TwinCollectionExecutor, type TwinCollectionWorkspace} from '@itookit/app-contracts';
import {label} from './view';

export function collectionDestinationFields(selected?: TwinCollectionExecutor): string {
    return `<div data-collection-destination${selected?.target.kind === 'tool' ? '' : ' hidden'}><label>${escapeHTML(label('collectionDestination'))}<select name="collectionDestination">
        <option value="">${escapeHTML(label('collectionDestination.project'))}</option>
        ${TWIN_COLLECTION_WORKSPACES.map(id => `<option value="${id}"${selected?.destination === id ? ' selected' : ''}>${escapeHTML(label('collectionDestination.' + id))} · ${escapeHTML(workspaceRoot(id))}</option>`).join('')}</select></label>
        <p class="twin__help">${escapeHTML(label('collectionDestinationHelp'))}</p></div>`;
}
export function readCollectionDestination(form: HTMLFormElement): TwinCollectionWorkspace | undefined {
    const destination = form.querySelector<HTMLSelectElement>('[name=collectionDestination]')?.value;
    if (!destination) return;
    if (!TWIN_COLLECTION_WORKSPACES.includes(destination as TwinCollectionWorkspace)) throw new Error(label('collectionDestinationInvalid'));
    return destination as TwinCollectionWorkspace;
}
export function collectionDestinationSummary(collection?: TwinCollectionExecutor): string {
    if (!collection) return '';
    const destination = collection.destination ? workspaceRoot(collection.destination) : label('collectionDestination.project');
    return `<p>${escapeHTML(label('collectionDestination'))}: <span data-collection-location="${escapeAttr(destination)}">${escapeHTML(destination)}</span></p>`;
}
