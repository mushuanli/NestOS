import {escapeAttr, escapeHTML, t, type LocaleKey} from '@itookit/common';
import type {ToolConnections, ToolConnectionType, ToolConnectionView} from '@itookit/app-contracts/services';
import {readUtf8File} from '../files/read-text-file';
const label = (key: string) => t(`toolbox.connections.${key}` as LocaleKey);
const button = (action: string, title: string, id: string) => `<button type="button" data-action="${escapeAttr(action)}" data-id="${escapeAttr(id)}">${escapeHTML(label(title))}</button>`;
export type SourceConnections = Awaited<ReturnType<ToolConnections['snapshot']>>;

export function sourceConnectionSettings(snapshot: SourceConnections): string {
    return `<details class="tool-connections"><summary>${escapeHTML(label('sourceConnections'))}</summary>
        <p class="tool-connections__help">${escapeHTML(label('sourceConnectionsHelp'))}</p>
        ${snapshot.types.length ? snapshot.types.map(type => `<section><h4>${escapeHTML(type.name)}</h4><p>${escapeHTML(type.description)}</p>
            ${snapshot.connections.filter(connection => connection.type === type.id).map(connection => connectionForm(type, connection)).join('')}
            <details><summary>${escapeHTML(label('addSourceConnection'))}</summary>${connectionForm(type)}</details></section>`).join('')
            : `<p>${escapeHTML(label('sourceConnectionsUnavailable'))}</p>`}</details>`;
}
function connectionForm(type: ToolConnectionType, connection?: ToolConnectionView): string {
    return `<form class="tool-connections__form" data-form="sourceConnection" data-id="${escapeAttr(connection?.id ?? 'new:' + type.id)}" data-type="${escapeAttr(type.id)}">
        <label>${escapeHTML(label('connectionAlias'))}<input name="id" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}" required value="${escapeAttr(connection?.id ?? '')}"${connection ? ' readonly' : ''}></label>
        <label>${escapeHTML(label('sourceConnectionName'))}<input name="name" maxlength="200" required value="${escapeAttr(connection?.name ?? '')}"></label>
        ${type.fields.map(field => `<label>${escapeHTML(field.label)}<input data-connection-field name="${escapeAttr(field.name)}" type="${field.secret ? 'password' : 'text'}" autocomplete="off" maxlength="16384"
            value="${escapeAttr(connection?.values[field.name] ?? '')}"${field.required && !connection?.configuredSecrets.includes(field.name) ? ' required' : ''}
            ${connection?.configuredSecrets.includes(field.name) ? `placeholder="${escapeAttr(label('secretConfigured'))}"` : ''}>${field.description ? `<small>${escapeHTML(field.description)}</small>` : ''}</label>`).join('')}
        <label>${escapeHTML(label('importConnection'))}<input type="file" name="connectionImport" accept=".json,application/json"></label>
        <button type="submit">${escapeHTML(label('save'))}</button>${connection ? button('removeSourceConnection', 'removeSourceConnection', connection.id) : ''}</form>`;
}
export async function importConnection(control: HTMLInputElement): Promise<void> {
    const file = control.files?.[0], form = control.closest('form');
    if (!file || !form) return;
    if (file.size > 64 * 1024) throw new Error(label('connectionImportInvalid'));
    const value: unknown = JSON.parse(await readUtf8File(file));
    if (!control.isConnected || control.files?.[0] !== file) return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label('connectionImportInvalid'));
    for (const field of form.querySelectorAll<HTMLInputElement>('[data-connection-field]')) {
        const item = (value as Record<string, unknown>)[field.name];
        if (item === undefined && !field.required) continue;
        if (typeof item !== 'string' || item.length > 16384) throw new Error(label('connectionImportInvalid'));
    }
    for (const field of form.querySelectorAll<HTMLInputElement>('[data-connection-field]')) {
        const item = (value as Record<string, unknown>)[field.name]; if (typeof item === 'string') field.value = item;
    }
    control.value = '';
}
