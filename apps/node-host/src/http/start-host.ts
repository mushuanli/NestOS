import {startUserHost} from './user-host';
import type { Server } from 'node:http';
import { closeHostResources, type HostCleanup } from '../runtime/host-runtime';
import { openNodeApplication } from '../runtime/application';
import { ViewApi } from './view-api';
import { createHttpServer } from './http-server';
import type { loadCertificates } from './certificates';
import {NodeEditorSwapStore} from '../storage/editor-swaps';

export interface HttpHostOptions {
    usersDir?: string;
    root: string; sidecar: string; certificates: Awaited<ReturnType<typeof loadCertificates>>; staticDir: string;
    auditFile: string; authDir: string; logMode?: string; port: number; host: string; backlog: number;
    editorSwap?: {enabled: boolean; directory: string};
}

/** Admit traffic only after the application's server readiness barrier succeeds. */
export async function startHost(options: HttpHostOptions) {
    if (options.usersDir) return startUserHost(options);
    if ((await options.certificates.users?.())?.some(user => user !== 'admin'))
        throw new Error('Certificate user mappings require --users-dir; single-user hosting only admits admin');
    console.warn('\u001b[1;31m【单用户模式：admin】所有访问均操作同一份 admin 数据。\u001b[0m');
    const cleanup: HostCleanup = [];
    try {
        const host = await openNodeApplication({...options, runtime: {startupMode: 'server'}}); cleanup.push(host.close);
        if (options.editorSwap?.enabled) {
            const swaps = await NodeEditorSwapStore.start(options.editorSwap.directory, options.root, options.staticDir);
            host.runtime.editorSwapStore = swaps; cleanup.push(() => swaps.dispose());
        }
        const {audit} = host;
        audit.write({event: 'server.mode', userId: 'admin', operation: 'server.start', stage: 'mode', result: 'single-user', code: 'SINGLE_USER_ADMIN'});
        const application = new ViewApi(Promise.resolve(host.runtime), audit, false);
        cleanup.push(() => application.close());
        const server = createHttpServer({ certificates: options.certificates, staticDir: options.staticDir, audit, application,
            build: { mode: options.logMode ?? process.env.NESTOS_HTTPD_MODE ?? 'standalone', version: process.env.NESTOS_HTTPD_VERSION } });
        cleanup.push(async () => {
            application.endStreams(); await stopServer(server);
            audit.write({ event: 'server.stopped' });
        });
        await listen(server, options);
        audit.write({ event: 'server.started', route: `https://${options.host}:${options.port}` });
        console.log(`NestOS HTTPS UI: https://${options.host}:${options.port}\nClient certificate required\nAudit log: ${options.auditFile}`);
        let closing: Promise<void> | undefined;
        return { server, close: () => closing ??= (async () => {
            audit.write({ event: 'server.stopping' }); await closeHostResources(cleanup);
            console.log('HTTP host stopped; data and credential locks released');
        })() };
    } catch (error) {
        try { await closeHostResources(cleanup); } catch { /* Preserve the startup error. */ }
        throw error;
    }
}

function listen(server: Server, { port, host, backlog }: HttpHostOptions): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ port, host, backlog }, () => { server.off('error', reject); resolve(); });
    });
}
function stopServer(server: Server): Promise<void> {
    return new Promise(resolve => {
        // A stalled request must not keep the host's storage locks alive indefinitely.
        const deadline = setTimeout(() => server.closeAllConnections(), 5000); deadline.unref();
        server.close(() => { clearTimeout(deadline); resolve(); });
        server.closeIdleConnections();
    });
}
