import type { Server } from 'node:http';
import { closeHostResources, type HostCleanup } from '../runtime/host-runtime';
import { openNodeApplication } from '../runtime/application';
import { ViewApi } from './view-api';
import { createHttpServer } from './http-server';
import type { loadCertificates } from './certificates';

export interface HttpHostOptions {
    root: string; sidecar: string; certificates: Awaited<ReturnType<typeof loadCertificates>>; staticDir: string;
    auditFile: string; authDir: string; logMode?: string; port: number; host: string; backlog: number;
}

/** Admit traffic only after the application's server readiness barrier succeeds. */
export async function startHost(options: HttpHostOptions) {
    const cleanup: HostCleanup = [];
    try {
        const host = await openNodeApplication({...options, runtime: {startupMode: 'server'}}); cleanup.push(host.close);
        const {audit} = host;
        const application = new ViewApi(Promise.resolve(host.runtime), audit, false);
        cleanup.push(() => application.close());
        const server = createHttpServer({ certificates: options.certificates, staticDir: options.staticDir, audit, application,
            build: { mode: options.logMode ?? process.env.MINDOS_HTTPD_MODE ?? 'standalone', version: process.env.MINDOS_HTTPD_VERSION } });
        cleanup.push(async () => { application.endStreams(); await stopServer(server); });
        await listen(server, options);
        audit.write({ event: 'server.started', route: `https://${options.host}:${options.port}` });
        console.log(`MindOS HTTPS UI: https://${options.host}:${options.port}\nClient certificate required\nAudit log: ${options.auditFile}`);
        let closing: Promise<void> | undefined;
        return { server, close: () => closing ??= (async () => {
            audit.write({ event: 'server.stopped' }); await closeHostResources(cleanup);
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
    return new Promise(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
}
