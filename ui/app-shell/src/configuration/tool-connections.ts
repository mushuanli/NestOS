import {createModuleLogger, escapeAttr, escapeHTML, randomUUID, t, type LocaleKey} from '@itookit/common';
import type {ToolConnections, ToolConnectionType, ToolConnectionView, ToolPackageGuide} from '@itookit/app-contracts/services';
import {readUtf8File} from '../files/read-text-file';
import {guideContent} from '../toolbox/package-guide';
import {applicationSettings, authorizationFields} from './tool-oauth-settings';
import {connectionStatus, connectionVerification} from './connection-verification';
const label = (key: string) => t(`toolbox.connections.${key}` as LocaleKey);
const button = (action: string, title: string, id: string) => `<button type="button" data-action="${escapeAttr(action)}" data-id="${escapeAttr(id)}">${escapeHTML(label(title))}</button>`;
const log = createModuleLogger('tool-connection-import');
export type SourceConnections = Awaited<ReturnType<ToolConnections['snapshot']>>;

export function sourceConnectionSettings(snapshot: SourceConnections, authorization = false, guides: ToolPackageGuide[] = [], methods: Record<string, Array<'browser' | 'import'>> = {}): string {
    return `<details class="tool-connections" data-connection-details="connections"${authorization ? ' open' : ''}><summary>${escapeHTML(label('sourceConnections'))}</summary>
        <p class="tool-connections__help">${escapeHTML(label('sourceConnectionsHelp'))}</p>
        ${snapshot.types.length ? snapshot.types.map(type => connectionSection(type, snapshot, authorization, guides, methods[type.id])).join('')
            : `<p>${escapeHTML(label('sourceConnectionsUnavailable'))}</p>`}</details>`;
}
function connectionSection(type: ToolConnectionType, snapshot: SourceConnections, authorization: boolean, guides: ToolPackageGuide[], methods?: Array<'browser' | 'import'>): string {
    const guide = guides.find(item => item.connectionTypes?.includes(type.id));
    const connections = snapshot.connections.filter(connection => connection.type === type.id), redirect = snapshot.authorizationRedirectUri;
    const oauth = authorization && type.authorization;
    const personal = oauth && (type.application || guide || methods?.includes('import'));
    const choices = methods ?? ['browser', 'import'], selected = choices.find(method => method !== 'browser' || type.application?.configured) ?? choices[0];
    return `<section data-connection-type="${escapeAttr(type.id)}"><h4>${escapeHTML(type.name)}</h4><p>${escapeHTML(type.description)}</p>
        ${connections.map(connection => `<details data-connection-details="account:${escapeAttr(connection.id)}"><summary>${escapeHTML(connection.name)} · ${escapeHTML(connectionStatus(connection))}</summary>${connectionForm(type, connection, authorization, redirect, !!guide && connection.authorization?.clientMode === 'personal')}</details>`).join('')}
        ${personal ? `<label>${escapeHTML(label('connectionMethod'))}<select data-connection-method>${choices.map(method => `<option value="${method}"${method === selected ? ' selected' : ''}>${escapeHTML(label(method === 'browser' ? 'webConnection' : 'localConnection'))}</option>`).join('')}</select></label>` : ''}
        <details data-method-panel="browser"${personal && selected !== 'browser' ? ' hidden' : ''} data-connection-details="new:${escapeAttr(type.id)}"${type.application?.configured && !connections.length ? ' open' : ''}>
            <summary>${escapeHTML(label(oauth ? 'webConnection' : 'addSourceConnection'))}</summary>
            ${authorization ? applicationSettings(type, redirect) : ''}${connectionForm(type, undefined, authorization, redirect)}</details>
        ${personal ? `<details data-method-panel="import"${selected !== 'import' ? ' hidden' : ''} data-connection-details="personal:${escapeAttr(type.id)}"${selected === 'import' && !connections.length ? ' open' : ''}>
            <summary>${escapeHTML(label('localConnection'))}</summary>${guide ? guideContent(guide) : `<p>${escapeHTML(label('localImportHelp'))}</p>`}
            ${connectionForm({...type, application: undefined}, undefined, authorization, redirect, true)}</details>` : ''}</section>`;
}
function connectionForm(type: ToolConnectionType, connection?: ToolConnectionView, authorization = false, redirect?: string, local = false): string {
    const managed = connection?.authorization?.clientMode === 'application' || type.application && connection?.authorization?.clientMode !== 'personal';
    const auth = type.authorization, privateFields = managed && auth ? [auth.clientIdField, auth.clientSecretField, auth.refreshTokenField] : [];
    const fields = type.fields.filter(field => !privateFields.includes(field.name));
    const advanced = !!managed || local, identity = connection?.id ?? (local ? 'personal:' : 'new:') + type.id;
    return `<form class="tool-connections__form" data-form="sourceConnection" data-id="${escapeAttr(identity)}" data-type="${escapeAttr(type.id)}"${local ? ' data-local-import novalidate' : ''}>
        ${connection ? `<strong>${escapeHTML(connection.name)}</strong>${connectionVerification(connection, authorization && !!auth)}` : ''}${local ? importControl() : ''}
        ${advanced ? `<details data-connection-details="fields:${escapeAttr(identity)}"><summary>${escapeHTML(label('advancedConnection'))}</summary><p class="tool-connections__help">${escapeHTML(label('connectionDefaults'))}</p>` : ''}
        ${authorization && !connection || managed && !connection ? '<input name="id" type="hidden">' : `<label>${escapeHTML(label('connectionAlias'))}<input name="id" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}" required value="${escapeAttr(connection?.id ?? '')}"${connection ? ' readonly' : ''}></label>`}
        <label>${escapeHTML(label('sourceConnectionName'))}<input name="name" maxlength="200" required value="${escapeAttr(connection?.name ?? type.name)}"></label>
        ${fields.map(field => connectionField(field, connection, local && field.name === auth?.refreshTokenField, local && (field.required === true || field.name === auth?.refreshTokenField))).join('')}
        ${advanced ? '</details>' : ''}
        ${!managed && !local ? importControl() : ''}
        ${managed && !connection && authorization ? '' : `<button type="submit">${escapeHTML(label(local ? 'saveImportedConnection' : 'save'))}</button>`}
        ${connection ? button('removeSourceConnection', 'removeSourceConnection', connection.id) : ''}
        ${authorization && auth ? local ? localAuthorizationStatus(connection) : authorizationFields(type, connection, redirect) : ''}</form>`;
}
function connectionField(field: ToolConnectionType['fields'][number], connection?: ToolConnectionView, tokenRequired = false, importRequired = false): string {
    const configured = connection?.configuredSecrets.includes(field.name);
    return `<label>${escapeHTML(field.label)}<input data-connection-field${importRequired ? ' data-import-required' : ''} name="${escapeAttr(field.name)}" type="${field.secret ? 'password' : 'text'}" autocomplete="off" maxlength="16384"
        value="${escapeAttr(connection?.values[field.name] ?? '')}"${(field.required || tokenRequired) && !configured ? ' required' : ''}
        ${configured ? `placeholder="${escapeAttr(label('secretConfigured'))}"` : ''}>${field.description ? `<small>${escapeHTML(field.description)}</small>` : ''}</label>`;
}
function importControl(): string {
    return `<label>${escapeHTML(label('importConnection'))}<input type="file" name="connectionImport" accept=".json,application/json"></label><p data-import-status role="status"></p>`;
}
function localAuthorizationStatus(connection?: ToolConnectionView): string {
    if (!connection) return '';
    return `<p>${escapeHTML(label('localReconnect'))}</p>${connection.authorization?.connected ? `<button type="button" data-auth-revoke="${escapeAttr(connection.id)}">${escapeHTML(label('revoke'))}</button>` : ''}`;
}
export function validateConnectionForm(form: HTMLFormElement): boolean {
    if (form.hasAttribute('data-local-import') && [...form.querySelectorAll<HTMLInputElement>('[data-connection-field][required]')].some(field => !field.value.trim())) {
        form.querySelector('[data-import-status]')!.textContent = label('importRequired'); return false;
    }
    for (const control of form.querySelectorAll<HTMLInputElement>('input')) {
        if (control.willValidate && !control.checkValidity()) {
            let parent: HTMLElement | null = control.parentElement;
            while (parent && parent !== form) {if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement;}
        }
    }
    return form.reportValidity();
}
export function connectionInput(form: HTMLFormElement) {
    const id = form.querySelector<HTMLInputElement>('[name=id]')!;
    if (id.type === 'hidden' && !id.value) id.value = randomUUID();
    const data = new FormData(form);
    return {id: String(data.get('id') ?? ''), type: form.dataset.type!, name: String(data.get('name') ?? ''),
        values: Object.fromEntries([...form.querySelectorAll<HTMLInputElement>('[data-connection-field]')].map(field => [field.name, field.value]))};
}
export async function importConnection(control: HTMLInputElement): Promise<void> {
    const file = control.files?.[0], form = control.closest('form');
    if (!file || !form) return;
    const started = performance.now(), operationId = randomUUID(); let stage = 'file-size';
    try {
        if (file.size > 64 * 1024) throw importError('TOOL_CONNECTION_IMPORT_SIZE', 'importTooLarge');
        stage = 'file-read'; const source = await readUtf8File(file);
        if (!control.isConnected || control.files?.[0] !== file) return;
        stage = 'json-parse'; const value: unknown = JSON.parse(source.replace(/^\uFEFF/, ''));
        stage = 'field-validation'; applyImportedValues(form, value);
        control.value = '';
        const status = form.querySelector('[data-import-status]'); if (status) status.textContent = label('importReady');
        log.info('tool.connection.import', {operationId, stage: 'form-ready', result: 'success', bytes: file.size, durationMs: Math.round(performance.now() - started)});
    } catch (error) {
        const code = (error as {code?: string}).code ?? (stage === 'json-parse' ? 'TOOL_CONNECTION_IMPORT_JSON' : 'TOOL_CONNECTION_IMPORT_READ');
        log.warn('tool.connection.import', {operationId, stage, result: 'failure', code, bytes: file.size, durationMs: Math.round(performance.now() - started)});
        const failure = error instanceof SyntaxError ? importError(code, 'importInvalidJson') : (error as {code?: string}).code ? error : importError(code, 'importReadFailed');
        const status = form.querySelector('[data-import-status]'); if (status) status.textContent = (failure as Error).message;
        throw failure;
    }
}
function applyImportedValues(form: HTMLFormElement, value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw importError('TOOL_CONNECTION_IMPORT_FIELDS', 'connectionImportInvalid');
    for (const field of form.querySelectorAll<HTMLInputElement>('[data-connection-field]')) {
        const item = (value as Record<string, unknown>)[field.name], required = field.required || field.hasAttribute('data-import-required');
        if (item === undefined && !required) continue;
        if (typeof item !== 'string' || item.length > 16384 || required && !item.trim()) throw importError('TOOL_CONNECTION_IMPORT_FIELDS', 'connectionImportInvalid');
    }
    for (const field of form.querySelectorAll<HTMLInputElement>('[data-connection-field]')) {
        const item = (value as Record<string, unknown>)[field.name]; if (typeof item === 'string') field.value = item;
    }
    const id = form.querySelector<HTMLInputElement>('[name=id]');
    if (id && !id.value.trim()) id.value = randomUUID();
}
function importError(code: string, key: string): Error {
    return Object.assign(new Error(label(key)), {code});
}
