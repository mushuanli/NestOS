import {mkdir, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createApplicationRuntime} from '@itookit/app-core';
import {openApplicationView} from '@itookit/app-core/host';
import {openLocalFSBackend} from '@itookit/vfsdriver-local';
import {NodeSqliteSidecarDb} from '@itookit/node-host/storage';
import {SessionProfileRecorder} from './session-profile-recorder';

const {values} = parseArgs({options: {fixture: {type: 'string'}, out: {type: 'string'}}});

async function main(): Promise<void> {
    if (!values.fixture || !values.out) throw new Error('Expected --fixture <generated temporary fixture> --out <artifact directory>');
    const fixture = await realpath(values.fixture), temporary = await realpath(tmpdir());
    if (path.dirname(fixture) !== temporary || !path.basename(fixture).startsWith('nestos-session-contention-'))
        throw new Error('Only isolated session-contention fixtures beneath the temporary directory are accepted');
    const out = path.resolve(values.out); await mkdir(out, {recursive: true});
    const recorder = new SessionProfileRecorder(); await recorder.start();
    let backend: Awaited<ReturnType<typeof openLocalFSBackend>> | undefined;
    let runtime: Awaited<ReturnType<typeof createApplicationRuntime>> | undefined;
    try {
        backend = await recorder.measure('api.openStorage', () => openLocalFSBackend({rootDir: path.join(fixture, 'data'),
            sidecarDir: path.join(fixture, 'meta'), durability: 'full', createDb: async file => recorder.database(await NodeSqliteSidecarDb.open(file))}));
        const storage = backend;
        runtime = await recorder.measure('api.runtime', () => createApplicationRuntime({backend: storage, ownerKind: 'cli', startupMode: 'headless', digitalTwinAutoStart: false}));
        await readInitialView(runtime, recorder);
    } finally {try {await recorder.stop(out);} finally {try {await runtime?.dispose();} finally {await backend?.close();}}}
    process.stdout.write(JSON.stringify({artifacts: out}) + '\n');
}

async function readInitialView(runtime: Awaited<ReturnType<typeof createApplicationRuntime>>, recorder: SessionProfileRecorder): Promise<void> {
    const summaries = await recorder.measure('api.listSummaries', () => runtime.sessionRepository.listSummaries());
    const view = await recorder.measure('api.createView', () => openApplicationView(runtime));
    try {
        if (summaries[0]) {
            const opened = await recorder.measure('api.openSessionView', () => view.backend.openSessionView(summaries[0].id));
            try {await recorder.measure('api.activate', () => opened.activate('main'));} finally {await opened.dispose();}
        }
        await recorder.measure('api.overview', () => view.backend.assistantOverview!());
    } finally {await view.close();}
}

void main().catch(error => {console.error(error instanceof Error ? error.message : 'Startup profile failed'); process.exitCode = 1;});
