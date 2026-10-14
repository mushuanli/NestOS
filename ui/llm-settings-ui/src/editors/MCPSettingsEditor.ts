import { SettingsValidationError } from '@itookit/ui-common';
// @file llm-ui/editors/MCPSettingsEditor.ts
import {
    generateShortUUID,
    escapeHTML as escape,
    t,
    MCP_TRANSPORT_ICONS,
    STATUS_META,
    ENTITY_ICONS
} from '@itookit/common';
import { BaseSettingsEditor, Toast, Modal } from '@itookit/ui-common';
import type { MCPServer, MCPDiscovery } from '@itookit/tools/mcp-contracts';
import type { IAgentManagementService } from '@itookit/kernel-adapters/contracts';
import { bindMCPContent, renderMCPPrompts, parseMCPStringMap } from './mcp-content';
import { mcpConfiguration, mcpTimeoutMs } from '@itookit/tools/mcp-contracts';



export type MCPConfigurationControls = import('@itookit/ui-common').ConfigurationFormControls<MCPServer,MCPDiscovery>;

// ─── helpers ──────────────────────────────────────────────────────────────────

function statusDot(status?: MCPServer['status']): string {
    const s = STATUS_META[status as keyof typeof STATUS_META] ?? STATUS_META.idle;
    const label = t(`status.${status ?? 'idle'}` as Parameters<typeof t>[0]);
    return `<span style="color:${s.color};font-size:.75rem">${s.dot} ${label}</span>`;
}

function statusBadge(status?: MCPServer['status']): string {
    if (status === 'connected')
        return `<span class="settings-badge settings-badge--success">${STATUS_META.connected.dot} ${t('status.connected')}</span>`;
    if (status === 'error')
        return `<span class="settings-badge settings-badge--danger">✕ ${t('status.error')}</span>`;
    return `<span class="settings-badge">${STATUS_META.idle.dot} ${t('status.idle')}</span>`;
}

// ─── MCPSettingsEditor ────────────────────────────────────────────────────────

export class MCPSettingsEditor extends BaseSettingsEditor<IAgentManagementService> {
    constructor(container: HTMLElement, service: IAgentManagementService, options: import('@itookit/ui-common').EditorOptions,
        private readonly controls?: MCPConfigurationControls) { super(container,service,options); }
    async destroy(): Promise<void> { await super.destroy(); this.controls?.dispose?.(); }
    private selectedId: string | null = null;
    private formOnly = false;
    async init(container: HTMLElement): Promise<void> {
        if (this.options.target?.kind === 'entity' && this.options.target.entityType === 'mcp') {
            this.formOnly = true; this.selectedId = this.options.target.id;
        }
        await super.init(container);
    }


    async render() {
        if (!await this.prepareRender()) return;
        const servers = await this.service.getMCPServers();

        if (this.selectedId && !servers.find(s => s.id === this.selectedId)) {
            this.selectedId = null;
        }
        if (!this.formOnly && !this.selectedId && servers.length > 0) {
            this.selectedId = servers[0].id;
        }

        const selected = servers.find(s => s.id === this.selectedId) ?? null;

        this.container.innerHTML = this.formOnly ? `<div class="settings-page">${selected ? this.renderDetail(selected) : this.renderEmptyState()}</div>` : `
            <div class="settings-split${this.selectedId ? ' has-detail' : ''}">
                <div class="settings-split__sidebar">
                    <div class="settings-split__header">
                        <h3 style="margin:0;font-size:.9375rem;font-weight:600">
                            <i class="fas fa-plug" style="margin-right:.5rem;opacity:.7"></i>MCP Servers
                        </h3>
                        <div class="settings-page__actions">
                            <button class="settings-btn-round" data-action="add"    title="${t('mcp.addNew')}"><i class="fas fa-plus"></i></button>
                            <button class="settings-btn-round" data-action="import" title="${t('mcp.importConfig')}"><i class="fas fa-file-import"></i></button>
                            <button class="settings-btn-round" data-action="export" title="${t('mcp.exportAll')}"><i class="fas fa-file-export"></i></button>
                        </div>
                    </div>
                    <div class="settings-split__list">
                        ${servers.length === 0 ? this.renderEmptyList() : servers.map(s => this.renderListItem(s)).join('')}
                    </div>
                </div>
                <div class="settings-split__content">
                    <button class="settings-mobile-back" data-action="mobile-back">&#8592; MCP Servers</button>
                    ${selected ? this.renderDetail(selected) : this.renderEmptyState()}
                </div>
            </div>`;

        if (selected && this.controls) {
            const section = document.createElement('section'); section.className = 'settings-section';
            this.container.querySelector('.settings-page, .settings-split__content')?.append(section);
            this.controls.render(section,selected);
        }
        this.bindEvents(servers);
        if (selected) bindMCPContent(this.container, selected, this.service);
    }

    // ─── List ───────────────────────────────────────────────────────────────

    private renderEmptyList() {
        return `
            <div class="settings-empty settings-empty--mini">
                <div class="settings-empty__icon" style="font-size:2rem">🔌</div>
                <p style="margin:.5rem 0">${t('mcp.empty.text')}</p>
                <button class="settings-btn settings-btn--primary settings-btn--sm" data-action="add">
                    <i class="fas fa-plus"></i> ${t('mcp.empty.action')}
                </button>
            </div>`;
    }

    private renderListItem(server: MCPServer) {
        const isSelected = server.id === this.selectedId;
        const transportIcon = MCP_TRANSPORT_ICONS[server.transport as keyof typeof MCP_TRANSPORT_ICONS] ?? '🌐';
        return `
            <div class="settings-list-item ${isSelected ? 'selected' : ''}" data-id="${escape(server.id)}" style="cursor:pointer">
                <span class="settings-list-item__icon" style="font-size:1.25rem">${escape(server.icon || ENTITY_ICONS.mcp)}</span>
                <div class="settings-list-item__info" style="min-width:0">
                    <div class="settings-list-item__title" data-name-for="${escape(server.id)}"
                         title="${t('tooltip.dblClickRename')}" style="cursor:text">${escape(server.name)}</div>
                    <div class="settings-list-item__desc">
                        ${transportIcon} ${t(`mcpTransport.${server.transport}` as Parameters<typeof t>[0]) ?? server.transport}
                    </div>
                </div>
                ${statusDot(server.status)}
            </div>`;
    }

    // ─── Detail ─────────────────────────────────────────────────────────────

    private renderDetail(server: MCPServer) {
        const tools     = (server.tools     as any[] | undefined) ?? [];
        const resources = (server.resources as any[] | undefined) ?? [];

        return `
            <!-- ── Header ── -->
            ${this.renderEntityHeader({
                icon:            escape(server.icon || ''),
                fallbackIcon:    ENTITY_ICONS.mcp,
                name:            escape(server.name),
                namePlaceholder: t('mcp.placeholder.name'),
                badges:  statusBadge(server.status),
                subtitle: escape(server.description || t(`mcpTransport.${server.transport}` as Parameters<typeof t>[0]) || server.transport),
                actions: `
                    <button class="settings-btn settings-btn--secondary" data-action="test">
                        <i class="fas fa-plug"></i> ${t('action.test')}
                    </button>

                    <button class="settings-btn settings-btn--danger" data-action="delete" title="${t('action.delete')}">
                        <i class="fas fa-trash"></i>
                    </button>`,
            })}

            <!-- ── Scrollable body ── -->
            <div style="overflow-y:auto;padding:1.25rem 1.75rem 2rem">

                <!-- Basic Info -->
                <div class="settings-section">
                    <h3 class="settings-section__title">${t('mcp.section.basic')}</h3>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem">
                        <div class="settings-form-group">
                            <label>${t('form.name')}</label>
                            <input class="settings-input" name="name" value="${escape(server.name)}" placeholder="${t('mcp.placeholder.name')}">
                        </div>
                        <div class="settings-form-group">
                            <label>${t('form.icon')} <span style="color:var(--st-text-tertiary);font-size:.8em">emoji</span></label>
                            <input class="settings-input" name="icon" value="${escape(server.icon || '')}" placeholder="🔌">
                        </div>
                    </div>
                    <div class="settings-form-group">
                        <label>${t('form.description')}</label>
                        <textarea class="settings-textarea" name="description" rows="2"
                            placeholder="${t('mcp.placeholder.desc')}">${escape(server.description || '')}</textarea>
                    </div>
                </div>

                <!-- Transport -->
                <div class="settings-section">
                    <h3 class="settings-section__title">${t('mcp.section.transport')}</h3>
                    <div class="settings-form-group">
                        <label>${t('mcp.transport.label')}</label>
                        <p>${t('mcp.protocolRequirement')}</p>
                        <select class="settings-select" name="transport" id="transport-select">
                            ${!['stdio', 'http'].includes(server.transport) ? `<option value="${escape(server.transport)}" selected disabled>${escape(server.transport)} — ${t('mcp.unsupportedTransport')}</option>` : ''}
                            <option value="stdio" ${(this.service.supportsMCPStdio?.() ?? false) ? '' : 'disabled'} ${server.transport === 'stdio' ? 'selected' : ''}>${MCP_TRANSPORT_ICONS.stdio} ${t('mcpTransport.stdio.option')}</option>
                            <option value="http"  ${server.transport === 'http'  ? 'selected' : ''}>${MCP_TRANSPORT_ICONS.http} ${t('mcpTransport.http.option')}</option>
                        </select>
                    </div>
                    ${!(this.service.supportsMCPStdio?.() ?? false) ? `<p>${t('mcp.stdioUnavailable')}</p>` : ''}
                    <div id="transport-fields">
                        ${this.renderTransportFields(server)}
                    </div>
                </div>

                <div class="settings-section"><label>${t('mcp.headers')}
                    <textarea class="settings-textarea" name="headers" rows="3">${escape(JSON.stringify(server.headers ?? {}, null, 2))}</textarea></label>
                    <label>${t('mcp.environment')}<textarea class="settings-textarea" name="env" rows="3">${escape(JSON.stringify(server.env ?? {}, null, 2))}</textarea></label></div>
                ${renderMCPPrompts(server)}
                <!-- Advanced -->
                <div class="settings-section">
                    <h3 class="settings-section__title">${t('mcp.section.advanced')}</h3>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;align-items:end">
                        <div class="settings-form-group" style="margin-bottom:0">
                            <label>${t('form.timeout')}</label>
                            <input class="settings-input" type="number" name="timeout"
                                value="${mcpTimeoutMs(server) / 1000}" min="0.001" max="300" step="0.001">
                        </div>
                        <div class="settings-checkbox-row" style="padding-bottom:.5rem">
                            <input type="checkbox" id="auto-connect" name="autoConnect"
                                ${server.autoConnect ? 'checked' : ''}>
                            <label for="auto-connect">${t('form.autoConnect')}</label>
                        </div>
                    </div>
                </div>

                <!-- Tools -->
                <div class="settings-section">
                    <h3 class="settings-section__title" style="display:flex;align-items:center;gap:.5rem">
                        Tools
                        <span class="settings-badge">${tools.length}</span>
                    </h3>
                    <p style="font-size:.75rem;color:var(--st-text-tertiary);margin:0 0 .5rem">
                        ${t('mcp.tools.hint')}
                    </p>
                    ${tools.length > 0 ? this.renderToolList(tools) : `
                        <div class="settings-empty settings-empty--mini">
                            <p style="color:var(--st-text-tertiary);font-size:.875rem">${t('mcp.tools.empty')}</p>
                        </div>`}
                </div>

                <!-- Resources -->
                <div class="settings-section" style="margin-bottom:0">
                    <h3 class="settings-section__title" style="display:flex;align-items:center;gap:.5rem">
                        Resources
                        <span class="settings-badge">${resources.length}</span>
                    </h3>
                    ${resources.length > 0 ? this.renderResourceList(resources) : `
                        <div class="settings-empty settings-empty--mini">
                            <p style="color:var(--st-text-tertiary);font-size:.875rem">${t('mcp.resources.empty')}</p>
                        </div>`}
                </div>
            </div>`;
    }

    private renderTransportFields(server: MCPServer) {
        if (server.transport === 'stdio') {
            return `
                <div class="settings-form-group">
                    <label>${t('mcp.command.label')} <span style="color:var(--st-text-tertiary);font-size:.8em">${t('mcp.command.hint')}</span></label>
                    <input class="settings-input" name="command" value="${escape(server.command || '')}"
                        placeholder="${t('mcp.placeholder.command')}" style="font-family:monospace">
                </div>
                <div class="settings-form-group">
                    <label>${t('mcp.args.label')} <span style="color:var(--st-text-tertiary);font-size:.8em">${t('mcp.args.hint')}</span></label>
                    <input class="settings-input" name="args" value="${escape(server.args || '')}"
                        placeholder="${t('mcp.placeholder.args')}" style="font-family:monospace">
                </div>
                <div class="settings-form-group">
                    <label>${t('mcp.cwd.label')} <span style="color:var(--st-text-tertiary);font-size:.8em">${t('mcp.cwd.hint')}</span></label>
                    <input class="settings-input" name="cwd" value="${escape(server.cwd || '')}"
                        placeholder="${t('mcp.placeholder.cwd')}" style="font-family:monospace">
                </div>`;
        }
        return `
            <div class="settings-form-group">
                <label>Endpoint URL</label>
                <input class="settings-input" type="url" name="endpoint" value="${escape(server.endpoint || '')}"
                    placeholder="${t('mcp.placeholder.endpoint')}">
            </div>
            <div class="settings-form-group">
                <label>${t('mcp.apiKey.label')} <span style="color:var(--st-text-tertiary);font-size:.8em">${t('mcp.apiKey.hint')}</span></label>
                <input class="settings-input" type="password" name="apiKey" value="${escape(server.apiKey || '')}"
                    placeholder="${t('mcp.placeholder.apiKey')}">
            </div>`;
    }

    private renderToolList(tools: any[]) {
        return `<div style="display:flex;flex-direction:column;gap:.375rem">${
            tools.map(tool => `
                <div class="settings-card" style="display:flex;align-items:center;gap:.75rem;padding:.625rem .875rem">
                    <i class="fas fa-wrench" style="color:var(--st-color-primary);flex-shrink:0;font-size:.875rem"></i>
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;font-size:.875rem;font-family:monospace">${escape(tool.name)}</div>
                        <div style="font-size:.8125rem;color:var(--st-text-secondary);
                                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                            ${escape(tool.description || t('mcp.tools.noDesc'))}</div>
                    </div>
                </div>`).join('')}
        </div>`;
    }

    private renderResourceList(resources: any[]) {
        return `<div style="display:flex;flex-direction:column;gap:.375rem">${
            resources.map((r, i) => `
                <div class="settings-card" style="display:flex;align-items:center;gap:.75rem;padding:.625rem .875rem">
                    <i class="fas fa-database" style="color:var(--st-color-primary);flex-shrink:0;font-size:.875rem"></i>
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;font-size:.875rem">${escape(r.name || r.uri)}</div>
                        <div style="font-size:.8125rem;color:var(--st-text-secondary);font-family:monospace;
                                    white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escape(r.uri)}</div>
                    </div>
                    <button class="settings-btn" data-action="preview-resource" data-index="${i}">${t('mcp.preview')}</button>
                </div>`).join('')}
        </div>`;
    }

    private renderEmptyState() {
        return `
            <div class="settings-empty" style="height:100%;justify-content:center">
                <div class="settings-empty__icon">${ENTITY_ICONS.mcp}</div>
                <div class="settings-empty__title">${t('mcp.select.title')}</div>
                <p style="color:var(--st-text-tertiary);font-size:.875rem;text-align:center;max-width:280px">
                    ${t('mcp.select.desc')}
                </p>
                <button class="settings-btn settings-btn--primary" data-action="add">
                    <i class="fas fa-plus"></i> ${t('mcp.select.action')}
                </button>
            </div>`;
    }

    // ─── Events ─────────────────────────────────────────────────────────────

    private bindEvents(servers: MCPServer[]) {
        this.clearListeners();

        // ── Mobile: back button clears selection ─────────────────────────────
        const mobileBack = this.container.querySelector<HTMLButtonElement>('[data-action="mobile-back"]');
        mobileBack?.addEventListener('click', () => { this.selectedId = null; this.render(); });

        // ── Sidebar: single click = select, double click = inline rename ──────
        const list = this.container.querySelector('.settings-split__list');
        if (list) {
            this.addEventListener(list, 'click', (e) => {
                if ((e.target as HTMLElement).closest('.settings-inline-rename')) return;
                const item = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
                if (item) { this.selectedId = item.dataset.id!; this.render(); }
            });
            this.addEventListener(list, 'dblclick', (e) => {
                const titleEl = (e.target as HTMLElement).closest('[data-name-for]') as HTMLElement | null;
                if (titleEl) this._startMCPInlineRename(titleEl, titleEl.dataset.nameFor!, servers);
            });
        }

        // ── Header name: auto-save on blur, kept in sync with form input ─────
        this.bindEntityHeaderEvents({
                        mirrorNameSelector:  '[name="name"]',
        });

        // ── Action buttons ────────────────────────────────────────────────────
        this.container.querySelectorAll('[data-action="add"]').forEach(el =>
            this.addEventListener(el, 'click', () => this.addNew()));
        this.bindAction('import',       () => this.showImport());
        this.bindAction('export',       () => this.exportAll(servers));
        const existing = servers.find(server => server.id === this.selectedId);
        if (existing) this.bindAutoSave(this.container.querySelector<HTMLElement>('.settings-split__content') ?? this.container, async () => {
            let draft: MCPServer;
            try { draft = this.readDraft(existing); } catch (error) { throw new SettingsValidationError((error as Error).message); }
            try { await this.service.saveMCPServer(structuredClone(draft)); this.controls?.committed?.(); }
            catch (error) { this.controls?.failed?.(); throw error; }
            Object.assign(existing, draft);
            const title = [...this.container.querySelectorAll<HTMLElement>('[data-name-for]')].find(element => element.dataset.nameFor === existing.id);
            if (title && !title.querySelector('input')) title.textContent = draft.name;
        });
        this.bindAction('delete',       () => this.deleteCurrent());
        this.bindAction('test',         () => this.testCurrent(servers));

        // ── Transport select ──────────────────────────────────────────────────
        const transportSel = this.container.querySelector<HTMLSelectElement>('#transport-select');
        if (transportSel) {
            this.addEventListener(transportSel, 'change', () => {
                const el = this.container.querySelector<HTMLElement>('#transport-fields');
                const dummy = { transport: transportSel.value } as MCPServer;
                if (el) el.innerHTML = this.renderTransportFields(dummy);
            });
        }


    }

    private bindAction(action: string, handler: () => void) {
        const el = this.container.querySelector(`[data-action="${action}"]`);
        if (el) this.addEventListener(el, 'click', handler);
    }

    private val(name: string) {
        return (this.container.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? '';
    }
    private chk(name: string) {
        return (this.container.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.checked ?? false;
    }

    private _startMCPInlineRename(titleEl: HTMLElement, serverId: string, servers: MCPServer[]): void {
        this.startInlineRename(
            titleEl,
            async (newName) => {
                const server = servers.find(s => s.id === serverId);
                if (!server) return;
                await this.service.saveMCPServer({ ...server, name: newName });
                server.name = newName; // patch local cache
            },
            (newName) => {
                if (serverId !== this.selectedId) return;
                const hdr = this.container.querySelector<HTMLInputElement>('[name="header-name"]');
                const frm = this.container.querySelector<HTMLInputElement>('[name="name"]');
                if (hdr) { hdr.value = newName; this.resizeHeaderInput(hdr); }
                if (frm) frm.value = newName;
            },
        );
    }

    // ─── Actions ────────────────────────────────────────────────────────────

    private async addNew() {
        const server: MCPServer = {
            id:        `mcp-${generateShortUUID()}`,
            name:      'New Server',
            transport: (this.service.supportsMCPStdio?.() ?? false) ? 'stdio' : 'http',
            status:    'idle',
            tools:     [],
            resources: [],
        };
        await this.service.saveMCPServer(server);
        this.selectedId = server.id;
        await this.render();
    }

    private readDraft(existing: MCPServer): MCPServer {
        const transport = this.val('transport') as MCPServer['transport'];
        if (!['stdio', 'http'].includes(transport)) throw new Error(t('mcp.unsupportedTransport'));
        const seconds = Number(this.val('timeout'));
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(t('mcp.invalidTimeout'));
        const draft: MCPServer = {
            ...existing, transport,
            headers: parseMCPStringMap(this.val('headers')), env: parseMCPStringMap(this.val('env')),
            name: this.val('header-name') || this.val('name') || existing.name,
            icon: this.val('icon') || undefined, description: this.val('description') || undefined,
            command: transport === 'stdio' ? this.val('command') || undefined : undefined,
            args: transport === 'stdio' ? this.val('args') || undefined : undefined,
            cwd: transport === 'stdio' ? this.val('cwd') || undefined : undefined,
            endpoint: transport !== 'stdio' ? this.val('endpoint') || undefined : undefined,
            apiKey: transport !== 'stdio' ? this.val('apiKey') || undefined : undefined,
            timeout: seconds * 1000, timeoutUnit: 'ms', autoConnect: this.chk('autoConnect'),
        };
        if (draft.apiKey && draft.auth) {
            draft.auth = undefined;
            draft.headers = Object.fromEntries(Object.entries(draft.headers ?? {}).filter(([key]) => key.toLowerCase() !== 'authorization'));
        }
        return this.controls?.read(draft) ?? draft;
    }

    private async deleteCurrent(): Promise<void> {
        await this.discardAutoSave();
        const id = this.selectedId; if (!id) return;
        const request = this.options.hostContext?.requestDelete;
        if (!request) throw new Error('Configuration deletion is not connected');
        await request([{ kind: 'entity', entityType: 'mcp', id }]);
        this.selectedId = null; await this.render();
    }

    private async testCurrent(servers: MCPServer[]) {
        const existing = servers.find(s => s.id === this.selectedId);
        const btn = this.container.querySelector<HTMLButtonElement>('[data-action="test"]');
        if (!existing || !btn) return;
        const originalHTML = btn.innerHTML;
        btn.textContent = t('status.testing'); btn.disabled = true;
        try {
            const draft = this.readDraft(existing);
            const discovered = await this.service.testMCPServer(draft);
            const verified = {...draft,extensions:{...draft.extensions,...discovered.extensions}};
            const configured = await this.controls?.tested?.(verified,discovered) ?? verified;
            await this.service.saveMCPServer({ ...configured, ...discovered, status: 'connected' });
            this.controls?.committed?.();
            Object.assign(existing,configured,discovered,{status:'connected'});
            Toast.success(t('mcp.discoverySuccess', { count: discovered.tools.length }));
            await this.render();
        } catch (error) { this.controls?.failed?.(); Toast.error(t('mcp.toast.testError', { message: (error as Error).message })); }
        finally { if (btn.isConnected) { btn.innerHTML = originalHTML; btn.disabled = false; } }
    }

    private showImport() {
        const body = `
            <p style="font-size:.875rem;color:var(--st-text-secondary);margin:0 0 .75rem">
                ${t('mcp.import.hint')}</p>
            <textarea class="settings-textarea" id="import-json" rows="8"
                placeholder="${t('mcp.import.placeholder')}"
                style="font-family:monospace;font-size:.8125rem"></textarea>`;
        new Modal(t('mcp.import.title'), body, {
            confirmText: t('dialog.import.action'),
            onConfirm: async () => {
                const text = (document.getElementById('import-json') as HTMLTextAreaElement).value;
                try {
                    const data = JSON.parse(text);
                    const arr: MCPServer[] = Array.isArray(data) ? data : [data];
                    for (const item of arr) {
                        item.id = item.id || `mcp-${generateShortUUID()}`;
                        await this.service.saveMCPServer(item);
                    }
                    Toast.success(t('mcp.toast.imported', { count: arr.length }));
                    if (arr.length > 0) this.selectedId = arr[arr.length - 1].id;
                    await this.render();
                } catch {
                    Toast.error(t('mcp.toast.invalidJson'));
                    return false;
                }
            },
        }).show();
    }

    private async exportAll(servers: MCPServer[]) {
        // Remove apiKey from export for security
        const safe = servers.map(server => {
            const {apiKey: _k, headers: _h, env: _e, ...rest} = mcpConfiguration(server); return rest;
        });
        const blob = new Blob([JSON.stringify(safe, null, 2)], { type: 'application/json' });
        const a = Object.assign(document.createElement('a'), {
            href: URL.createObjectURL(blob), download: 'mcp-servers.json',
        });
        a.click();
        URL.revokeObjectURL(a.href);
    }
}
