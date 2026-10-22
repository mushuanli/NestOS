import {createBrowserImageTools} from '@itookit/image-tools/browser';
import { createMindosLlmPresets } from '@itookit/kernel-adapters/llm/presets';
import { openApplicationView } from '@itookit/app-core/host';
import { createMindosFlowLibrary } from '@itookit/app-core';
import { createMindOSNodeDriver } from '@itookit/mindos-node-driver';
import { createTauriMCPTransport } from './shell/tauri-mcp-transport';
import { recordDiagnostic, observeTools } from './log/desktop-diagnostics';
import { errorDetails, t } from '@itookit/common';
import { TauriSessionDirectories } from './services/session-directories';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { installWindowClose } from './shell/window-lifecycle';
import { createTauriSessionProcesses } from './shell/session-bash';
import { TauriFlowWorkspaces } from './shell/flow-workspaces';
import { createFileSystemSource } from '@itookit/vfs-core';
/**
 * @file apps/tauri-app/src/main.ts
 *
 * Tauri-specific bootstrap:
 *  1. Resolve homeDir + rootDir via Tauri commands
 *       rootDir = resolved data root (mindos.json#rootDir or <config>/data)
 *  2. Build backends:
 *       rootBackend  = LocalFSBackend at <rootDir>/        (all shared modules)
 *       homeBackend  = LocalFSBackend at <homeDir>         (local filesystem)
 *       meta sidecar = <rootDir>/meta/<path-derived-name>  (home + dynamic mounts)
 *  3. Hand off to app-shell (all common logic lives there)
 *  4. Wire tauri-only features: loading overlay, dynamic local mounts
 */

import { initApp, installMobileNavigation, windowSessionLeaseToken, workspaceRoot, type AppUI } from '@itookit/app-shell';
import { createApplicationRuntime } from '@itookit/app-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { createFlowContextMenuConfig, createAIContextMenuConfig,
    restoreFlowLibrary } from '@itookit/llm-ui-adapter/startup';
import {
    ProviderSettingsEditor,
    ConnectionSettingsEditor,
    ModelDefaultsEditor,
    MCPSettingsEditor,
    CostEditor,
    SystemPromptSettingsEditor,
} from '@itookit/llm-settings-ui';
import { WORKSPACES } from './config/modules';
import { TauriSqlSidecarDb } from './db/tauri-sql-sidecar';
import { TauriFsOps } from './fs/tauri-fs-ops';
import { TauriLLMLogger } from './log/tauri-llm-logger';
import { startVfsTrace } from './log/vfs-trace';
import { createSendBoundary } from './log/send-boundary';
import { SessionCommand } from '@itookit/llm-session';
import { TauriSkillSource } from './kernel/tauri-skill-source';

// ── Path helpers ───────────────────────────────────────────────────────────────

type EditorFactory = ReturnType<AppUI['createChatEditor']>;

function lazyEditorFactory(load: () => Promise<EditorFactory>): EditorFactory {
    let pending: Promise<EditorFactory> | undefined;
    return async (container, options) => (await (pending ??= load()))(container, options);
}

const entryAt = performance.now();
const documentAt = performance.getEntriesByName('mindos.document')[0]?.startTime;
void recordDiagnostic('bootstrap.entry', {
    timeOrigin: performance.timeOrigin, entryMs: Math.round(entryAt),
    documentMs: documentAt === undefined ? undefined : Math.round(documentAt),
    documentToEntryMs: documentAt === undefined ? undefined : Math.round(entryAt - documentAt),
    resourceCount: performance.getEntriesByType('resource').length,
});

/**
 * Derive a stable sidecar directory path from an absolute filesystem path.
 * /Users/rain/Projects → <rootDir>/meta/Users_rain_Projects
 */
function pathToMetaDir(rootDir: string, absPath: string): string {
    const name = absPath.replace(/^\/+/, '').replace(/\//g, '_');
    return `${rootDir}/meta/${name}`;
}

// ── Loading overlay ────────────────────────────────────────────────────────────
let diagnosticLogPath: string | undefined;

function showLoading(msg: string): void {
    // Guard static navigation until app-shell has installed its handlers.
    document.body.classList.add('is-booting');
    let el = document.getElementById('__boot-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = '__boot-overlay';
        el.style.cssText = [
            'position:fixed;inset:0;z-index:9999',
            'background:var(--bg-secondary,#f1f5f9)',
            'display:flex;flex-direction:column;align-items:center;justify-content:center',
            'font-family:var(--font-primary,sans-serif);gap:12px',
        ].join(';');
        el.innerHTML = `
            <div style="width:36px;height:36px;border:3px solid #ddd;border-top-color:var(--primary-color,#5B66F5);border-radius:50%;animation:spin 0.8s linear infinite"></div>
            <div id="__boot-msg" style="font-size:13px;color:#6b7280"></div>
            <style>@keyframes spin{to{transform:rotate(360deg)}}</style>`;
        document.body.appendChild(el);
    }
    const msgEl = document.getElementById('__boot-msg');
    if (msgEl) msgEl.textContent = msg;
}

function hideLoading(): void {
    document.getElementById('__boot-overlay')?.remove();
    document.body.classList.remove('is-booting');
}

function showError(msg: string): void {
    if (diagnosticLogPath) msg += `\n\n${t('boot.runtimeLog')}${diagnosticLogPath}`;
    const el = document.getElementById('__boot-overlay');
    if (el) {
        // A fatal failure takes over the whole window, not just the content area.
        el.classList.add('boot-overlay--error');
        el.innerHTML = `
            <div style="font-size:28px">⚠️</div>
            <div style="font-size:14px;font-weight:600;color:#111">启动失败</div>
            <div id="__boot-error" style="font-size:12px;color:#ef4444;max-width:720px;text-align:left;white-space:pre-wrap;word-break:break-all"></div>
            <button onclick="location.reload()" style="margin-top:8px;padding:6px 16px;border-radius:6px;border:none;background:var(--primary-color,#5B66F5);color:#fff;cursor:pointer;font-size:13px">重试</button>`;
        el.querySelector('#__boot-error')!.textContent = msg;
    } else {
        alert(`启动失败: ${msg}`);
    }
}

// ── Tauri path resolution ──────────────────────────────────────────────────────

async function getHomeDir(): Promise<string> {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<string>('get_home_dir');
    } catch {
        return (globalThis as unknown as { __CWD__?: string }).__CWD__ ?? '.';
    }
}

/**
 * Returns the resolved VFS root directory.
 * Config lives at ~/.config/mindos/mindos.json; the data root comes from
 * mindos.json#rootDir, the MINDOS_ROOT env var, or ~/.config/mindos/data.
 */
async function getRootDir(): Promise<string> {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<string>('get_root_dir');
    } catch {
        // Fallback for plain Vite dev (no Tauri context)
        const home = (globalThis as { process?: { env?: { HOME?: string } } })
            .process?.env?.HOME ?? '.';
        return `${home}/.config/mindos/data`;
    }
}

/**
 * Where the resolved root and workspace came from — `mindos.json#rootDir`,
 * `INIT_CWD (launch dir)`, `<config_dir>/data (default)`, and so on.
 */
async function getPathSources(): Promise<{ root: string; home: string }> {
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<{ root: string; home: string }>('get_path_sources');
    } catch {
        return { root: 'unknown', home: 'unknown' };
    }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
    installMobileNavigation();
    const t0 = performance.now();
    let t = t0;
    const log = (label: string) => {
        const now = performance.now();
        console.log(`[Boot] ${label}: +${(now - t).toFixed(0)}ms (total ${(now - t0).toFixed(0)}ms)`);
        void recordDiagnostic('bootstrap.stage', { label, durationMs: Math.round(now - t), elapsedMs: Math.round(now - t0) });
        t = now;
        showLoading(label);
    };

    log('正在初始化…');
    diagnosticLogPath = await invoke<string | undefined>('diagnostic_log_path').catch(() => undefined);
    if (diagnosticLogPath) console.info(`[Diagnostics] ${diagnosticLogPath}`);

    // 1. Resolve paths
    //    homeDir   = working project directory (CWD or --home arg)
    //    rootDir   = resolved data root (mindos.json#rootDir, never ~/.mindos)
    const [homeDir, rootDir, sources] = await Promise.all([getHomeDir(), getRootDir(), getPathSources()]);
    log(`路径解析 (home=${homeDir})`);
    console.log(`[Boot] MindOS root=${rootDir} (${sources.root}); 工作目录 home=${homeDir} (${sources.home})`);

    const dirName = homeDir.split('/').filter(Boolean).pop() ?? homeDir;
    const navLabel = document.getElementById('nav-home-label');
    if (navLabel) navLabel.textContent = dirName;
    const navBtn = document.getElementById('nav-home-btn');
    if (navBtn) navBtn.title = homeDir;
    const badge = document.getElementById('home-dir-label');
    if (badge) { badge.textContent = dirName; badge.title = homeDir; }

    // 2. Build backends
    //
    //  rootBackend          : <rootDir>/  — system paths only (/etc/, /dev/)
    //                         SQLite: <rootDir>/_meta/
    //  workspace backends   : <rootDir>/home/admin/<name>/  — one SQLite each
    //                         SQLite: <rootDir>/_db/<name>/
    //  homeBackend          : <homeDir>  — transparent local FS
    //                         SQLite: <rootDir>/meta/<path-derived>/
    //
    // Each module gets its own SQLite to eliminate cross-module DB locking.

    const openBackend = async (rootDir: string, sidecarDir: string) => {
        const started = performance.now();
        void recordDiagnostic('bootstrap.source.start', { rootDir, sidecarDir });
        try {
            const backend = await openLocalFSBackend({ rootDir, sidecarDir,
                createDb: dbPath => TauriSqlSidecarDb.open(dbPath), createFs: () => new TauriFsOps() });
            void recordDiagnostic('bootstrap.source.ready', { rootDir, sidecarDir, durationMs: Math.round(performance.now() - started) });
            return backend;
        } catch (error) {
            const failure = new Error(`Open filesystem root=${rootDir}, database=${sidecarDir}/index.db`, { cause: error });
            void recordDiagnostic('bootstrap.source.failed', failure);
            throw failure;
        }
    };

    // Collect module names that need their own backend (skip settings/home)
    const workspaceNames = WORKSPACES
        .filter(ws => ws.type !== 'settings' && ws.workspaceName !== 'home')
        .map(ws => ws.workspaceName);

    console.log(`[Boot] 创建 ${workspaceNames.length + 2} 个文件系统后端 (${workspaceNames.concat('root', 'home').join(', ')})`);


    // Open all backends in parallel — different SQLite files, no contention
    const opened = await Promise.allSettled([
        openBackend(rootDir, `${rootDir}/_meta`),
        openBackend(homeDir, pathToMetaDir(rootDir, homeDir)),
        ...workspaceNames.map(name =>
            openBackend(`${rootDir}${workspaceRoot(name)}`, `${rootDir}/_db/${name}`)
        ),
    ]);
    const sourceNames = ['root', 'home', ...workspaceNames];
    const failures = opened.flatMap((result, index) => result.status === 'rejected'
        ? [new Error(`Filesystem source ${sourceNames[index]} failed`, { cause: result.reason })] : []);
    if (failures.length) {
        const closed = await Promise.allSettled(opened.flatMap(result => result.status === 'fulfilled' ? [result.value.close()] : []));
        throw new AggregateError([...failures, ...closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])], 'Filesystem sources could not be opened');
    }
    const [rootBackend, homeBackend, ...workspaceBackends] = opened.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
    });
    const startupCleanup: Array<() => void | Promise<void>> = [
        ...[rootBackend, homeBackend, ...workspaceBackends].map(backend => () => backend.close()),
    ];
    try {
    log(`文件系统初始化 (${workspaceNames.length + 2} backends)`);

    // The host owns this source independently of the MindOS root.
    const homeSource = await createFileSystemSource({ tags: false, backend: homeBackend, viewId: 'host-home' });
    startupCleanup.push(() => homeSource.dispose());

    const workspaceMounts = workspaceNames.map((name, i) => ({
        path: workspaceRoot(name),
        backend: workspaceBackends[i],
    }));

    // 3. Hand off to app-shell
    // Session Bash runs through the platform directory-grant namespace.
    const ui: AppUI = {
        createChatEditor: (agents, deps) => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui-adapter/chat')).createLLMFactory(agents, {
                ...deps, onLoadMetrics: metrics => { void recordDiagnostic('session.load.ready', metrics); },
            })),
        createAgentEditor: (agents, capabilities) => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui-adapter/settings')).createAgentEditorFactory(agents, capabilities)),
        createFlowEditor: deps => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui-adapter/chat')).createFlowsEditorFactory(deps)),
        createFlowContextMenu: deps => createFlowContextMenuConfig({ ...deps, library: createMindosFlowLibrary() }),
        restoreFlowLibrary: commands => restoreFlowLibrary(commands, createMindosFlowLibrary()),
        createSkillEditor: agents => lazyEditorFactory(async () =>
            (await import('@itookit/llm-ui-adapter/settings')).createSkillsEditorFactory(agents)),
        createAIContextMenu: createAIContextMenuConfig,
        llmUiEditors: {
            ProviderSettingsEditor,
            ConnectionSettingsEditor, ModelDefaultsEditor,
            MCPSettingsEditor,
            CostEditor,
            SystemPromptSettingsEditor,
        },
    };
    const flowWorkspaces = new TauriFlowWorkspaces(rootDir);
    const llmLogger = new TauriLLMLogger(rootDir);
    const runtime = await createApplicationRuntime({
        startupMode: 'interactive',
        remoteSourceProvider: createMindOSNodeDriver(),
        backend: rootBackend,
        additionalMounts: [...workspaceMounts],
        ownerKind: 'tauri',
        mcp: { stdioTransport: createTauriMCPTransport() },
        // The same window keeps its lease identity across reloads, so a refresh can take over
        // the Sessions its previous page still leases instead of leaving them read-only for a TTL.
        sessionOwnerToken: windowSessionLeaseToken(),
        onProgress: log,
        llmLogger,
        directorySourceProvider: new TauriSessionDirectories(rootDir),
        defaultSessionDirectory: `host:${homeDir}`,
        kernelPlatform: {
            additionalTools: createBrowserImageTools(),
            configureSession: (sessionId, { toolDriver }) => observeTools(toolDriver, sessionId),
            configure: (kernel, services) => flowWorkspaces.bind(kernel, services),
            beforeSessionRecovery: sessionId => flowWorkspaces.reconcile(sessionId),
            flowWorkspaceManager: flowWorkspaces,
            fileContextForScope: (sessionId, rootTaskId) => flowWorkspaces.fileContext(sessionId, rootTaskId),
            createSessionProcesses: createTauriSessionProcesses(rootDir),
            skillSourceForSession: files => new TauriSkillSource(files.vfs, files.cwd),
        },
    });
    startupCleanup.push(() => runtime.dispose());
    const client = await openApplicationView(runtime);
    startupCleanup.push(() => client.close());
    recordDiagnostic('workspace.default', { sessionDirectory: homeDir, rootDir });
    // Acceptance diagnostics: VITE_MINDOS_TRACE=1 records per-interval VFS + sidecar op counts
    // so a slow user action can be attributed to backend/IPC round trips.
    if (import.meta.env.VITE_MINDOS_TRACE === '1') {
        const stopTrace = startVfsTrace(rootDir, runtime.vfs, { sidecar: rootBackend });
        window.__MINDOS_TRACE__ = stopTrace;
        // Bracket one send with an exact boundary so "≤2s / ≤100 calls" is measured on
        // the action itself instead of inferred from a wider interval. Session events are
        // routed per bound Session, so the send is observed at the command bus instead.
        const boundary = createSendBoundary(stopTrace);
        llmLogger.onResponse = () => boundary.responded();
        const commandBus = client.services.commandBus;
        const execute = commandBus.execute.bind(commandBus) as typeof commandBus.execute;
        commandBus.execute = <T>(name: string, args?: unknown): Promise<T> => {
            if (name !== SessionCommand.Send) return execute<T>(name, args);
            boundary.accepted();
            const result = execute<T>(name, args);
            result.catch(() => boundary.abandoned());
            return result;
        };
        startupCleanup.push(() => {
            commandBus.execute = execute;
            stopTrace();
            if (window.__MINDOS_TRACE__ === stopTrace) delete window.__MINDOS_TRACE__;
        });
        console.log('[Boot] VFS trace enabled -> var/log/vfs-trace.log');
    }
    const app = await initApp({
        fileTemplates: { agent: JSON.stringify(createMindosLlmPresets().agents, null, 2) },
        ...client,
        workspaces: WORKSPACES.map(ws => ws.workspaceName === 'home' ? { ...ws, files: { fs: homeSource.fs, cwd: '/' } } : ws),
        defaultSlug: 'start', startPage: true,
        routeAliases: { home: 'llm-workspace', projects: 'llm-workspace', workbench: 'llm-workspace' },
        onProgress: log,
        onShellReady: hideLoading,
        ui,
    });
    startupCleanup.push(() => app.destroy());
    app.onDestroy(() => runtime.dispose(), 'sources');
    app.onDestroy(() => client.close(), 'sources');
    app.onDestroy(() => homeSource.dispose(), 'sources');
    await installWindowClose(getCurrentWindow(), app);
    log('App 初始化完成');

    // Restore directory bookmarks into the shared project tree.
    const localRegistry = await app.vfs.openFileSystem('/var/lib/kernel/local-sources');
    if (await localRegistry.driver.exists('/sources.json')) {
        const saved = JSON.parse(await localRegistry.driver.readContent('/sources.json', { encoding: 'utf-8' }));
        if (saved.version === 1 && Array.isArray(saved.entries)) for (const entry of saved.entries) {
            if (typeof entry.localPath !== 'string') continue;
            try { await runtime.projects.ensureDirectory(`host:${entry.localPath}`, typeof entry.label === 'string' ? entry.label : undefined); }
            catch (error) { console.warn('[Projects] Directory unavailable', entry.localPath, error); }
        }
    }

    console.log(`[Boot] 总启动耗时: ${(performance.now() - t0).toFixed(0)}ms`);
    void recordDiagnostic('bootstrap.ready', { durationMs: Math.round(performance.now() - t0) });
    } catch (error) {
        for (const close of startupCleanup.reverse()) { try { await close(); } catch (cleanupError) { console.error('[Boot] Source cleanup failed', cleanupError); } }
        throw error;
    }
}

async function bootstrapRemote(): Promise<void> {
    const api = (window as { __MINDOS_API__?: string }).__MINDOS_API__ ?? '/api';
    const read = async <T>(path: string): Promise<T> => {
        const response = await fetch(`${api}${path}`);
        if (!response.ok) throw new Error(`${path}: ${response.status}`);
        return response.json() as Promise<T>;
    };
    const render = async (): Promise<void> => {
        const [status, sessions, runs] = await Promise.all([
            read<{ ready: boolean; profile: string; workspace: string; sessions: number }>('/status'),
            read<Array<{ id: string; title: string; origin?: string; updatedAt: number }>>('/sessions'),
            read<Array<{ runId: string; sessionId: string; title: string; origin?: string; status: string; updatedAt: number }>>('/runs'),
        ]);
        const label = document.getElementById('nav-home-label');
        if (label) label.textContent = status.profile.split('/').filter(Boolean).pop() ?? 'remote';
        document.querySelectorAll('.workspace-view').forEach(view => view.classList.remove('active'));
        const target = document.getElementById('llm-workspace');
        if (!target) return;
        target.classList.add('active');
        target.innerHTML = `
            <div style="padding:24px;max-width:980px;font-family:var(--font-primary,sans-serif)">
                <div style="padding:12px 16px;border-radius:10px;background:#eef2ff;color:#3730a3;margin-bottom:20px">
                    Remote mode · CLI runtime ready=${String(status.ready)} · profile=${status.profile}
                </div>
                <h2 style="margin:0 0 12px">AI Sessions (${sessions.length})</h2>
                <div style="display:grid;gap:8px;margin-bottom:28px">
                    ${sessions.length ? sessions.map(session => `
                        <div style="padding:12px 14px;border:1px solid #e5e7eb;border-radius:8px;background:#fff">
                            <div style="font-weight:600">${escapeHtml(session.title)}</div>
                            <div style="font-size:12px;color:#6b7280">${session.id} · origin=${session.origin ?? 'unknown'} · ${new Date(session.updatedAt).toLocaleString()}</div>
                        </div>`).join('') : '<div style="color:#6b7280">No sessions yet.</div>'}
                </div>
                <h2 style="margin:0 0 12px">Runs (${runs.length})</h2>
                <div style="display:grid;gap:8px">
                    ${runs.length ? runs.map(run => `
                        <div style="padding:12px 14px;border:1px solid #e5e7eb;border-radius:8px;background:#fff">
                            <div style="font-weight:600">${escapeHtml(run.title)}</div>
                            <div style="font-size:12px;color:#6b7280">${run.runId} · ${run.status} · origin=${run.origin ?? 'unknown'} · ${new Date(run.updatedAt).toLocaleString()}</div>
                        </div>`).join('') : '<div style="color:#6b7280">No runs yet.</div>'}
                </div>
            </div>`;
    };
    await render();
    setInterval(() => { void render().catch(error => console.error('[Remote] refresh failed', error)); }, 5_000);
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

if ((window as { __MINDOS_MODE__?: string }).__MINDOS_MODE__ === 'remote') {
    bootstrapRemote().catch(err => {
        recordDiagnostic('bootstrap.failed', err);
        console.error('[Remote Bootstrap] Fatal:', err);
        showError(errorDetails(err));
    });
} else {
    bootstrap().catch(err => {
        recordDiagnostic('bootstrap.failed', err);
        console.error('[Bootstrap] Fatal:', err);
        showError(errorDetails(err));
    });
}

window.addEventListener('unhandledrejection', (e) => {
    console.error('[Unhandled rejection]', e.reason);
    if (document.getElementById('__boot-overlay')) showError(errorDetails(e.reason));
});
