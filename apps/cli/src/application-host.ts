import path from 'node:path';
import { openNodeApplication, configDirectory, resolveHttpDirectories, type NodeApplicationHost } from '@itookit/node-host/runtime';
import { openApplicationView } from '@itookit/app-core/host';
import type { ApplicationClient } from '@itookit/app-contracts/services';
import type { CommandOptions } from './commands';
import { resolveProfileRoot } from './mindos';
import { CliDirectorySourceProvider } from './directories';
import { runtimeDiagnosticPath } from './diagnostics';

export async function openLocalApplication(options: CommandOptions, initializeWorkspace = false): Promise<NodeApplicationHost> {
    const root = resolveProfileRoot(options.profile), config = configDirectory();
    const authDir = options.profile && options.profile !== 'desktop' ? options.authDir ?? root + '.auth'
        : (await resolveHttpDirectories(config, process.env.INIT_CWD ?? process.cwd(), {authDir: options.authDir}, 'release')).authDir;
    return openNodeApplication({root, sidecar: path.join(root, '_meta'),
        authDir,
        auditFile: options.auditFile ?? path.join(path.dirname(runtimeDiagnosticPath() ?? path.join(config, 'logs', 'cli', 'cli-local.jsonl')), `cli-local-${process.pid}-audit.jsonl`),
        runtime: {startupMode: 'headless', digitalTwinAutoStart: initializeWorkspace,
            directorySourceProvider: new CliDirectorySourceProvider(root),
            defaultSessionDirectory: initializeWorkspace || options.setHome ? `host:${path.resolve(options.setHome ?? process.cwd())}` : undefined}});
}

/** Transport selection belongs to the CLI host; commands consume only ApplicationClient. */
export async function openCliApplication(options: CommandOptions): Promise<{client: ApplicationClient; close(): Promise<void>}> {
    if (options.connect) {
        const [{HttpViewClient}, {openNodeHttpClient}] = await Promise.all([import('@itookit/app-transport/http'), import('@itookit/node-host/client')]);
        const endpoint = new URL(options.connect);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('--connect requires an HTTPS endpoint without embedded credentials');
        const transport = await openNodeHttpClient(options);
        const view = new HttpViewClient(crypto.randomUUID(), new URL('/api/application', endpoint).href, transport.fetcher);
        try {
            const client = await view.start(); let closing: Promise<void> | undefined;
            return {client, close: () => closing ??= (async () => { try { await view.close(); } finally { transport.close(); } })()};
        }
        catch (error) { await view.close().catch(() => {}); transport.close(); throw error; }
    }
    const host = await openLocalApplication(options);
    try {
        const view = await openApplicationView(host.runtime);
        let closing: Promise<void> | undefined;
        return {client: view, close: () => closing ??= (async () => { try { await view.close(); } finally { await host.close(); } })()};
    } catch (error) { await host.close(); throw error; }
}
