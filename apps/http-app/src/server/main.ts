import { mkdir, realpath, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { NodeSqliteSidecarDb } from './sqlite-sidecar';
import { createHttpServer } from './http-server';

async function main(): Promise<void> {
    const values = options();
    if (values.help) { console.log('MindOS HTTP: --host 127.0.0.1 --port 2000 --root ./data [--sidecar ./data/_meta] [--static ./dist]'); return; }
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a port between 1 and 65535');
    const cwd = process.env.INIT_CWD ?? process.cwd();
    const root = path.resolve(cwd, values.root ?? '.mindos-http');
    const sidecar = path.resolve(cwd, values.sidecar ?? path.join(root, '_meta'));
    const staticDir = values.static ? path.resolve(cwd, values.static) : fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../dist/' : '../dist/', import.meta.url));
    await access(path.join(staticDir, 'index.html'));
    await mkdir(root, { recursive: true }); await mkdir(sidecar, { recursive: true });
    const canonicalRoot = await realpath(root), canonicalSidecar = await realpath(sidecar);
    if (canonicalSidecar === canonicalRoot || (canonicalSidecar.startsWith(`${canonicalRoot}${path.sep}`)
        && canonicalSidecar !== path.join(canonicalRoot, '_meta'))) throw new Error('Sidecar must be <root>/_meta or outside the VFS data root');
    const backend = await openLocalFSBackend({ rootDir: canonicalRoot, sidecarDir: canonicalSidecar,
        durability: 'full', createDb: file => NodeSqliteSidecarDb.open(file) });
    const server = createHttpServer(backend, canonicalRoot, staticDir);
    const stop = () => { server.close(() => { void backend.close().finally(() => process.exit(0)); }); server.closeIdleConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    server.once('error', error => { console.error(error.message); void backend.close().finally(() => process.exit(1)); });
    server.listen(port, values.host, () => console.log(`MindOS HTTP UI: http://${values.host}:${port}\ndata: ${canonicalRoot}\nsidecar: ${canonicalSidecar}`));
}

function options() {
    const { values } = parseArgs({ options: {
        root: { type: 'string' }, sidecar: { type: 'string' }, host: { type: 'string', default: '127.0.0.1' },
        port: { type: 'string', default: '2000' }, static: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } });
    return values;
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
