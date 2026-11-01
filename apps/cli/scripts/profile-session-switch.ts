import {parseArgs} from 'node:util';
import {performance} from 'node:perf_hooks';
import {openCliApplication} from '../src/application-host';

const {values} = parseArgs({options: {
    connect: {type: 'string'}, session: {type: 'string', multiple: true},
    'client-cert': {type: 'string'}, 'client-key': {type: 'string'}, 'ca-cert': {type: 'string'},
    samples: {type: 'string', default: '3'}, overview: {type: 'boolean', default: false},
}});

/** Measure the authenticated HTTP backend without DOM rendering or message submission. */
async function main(): Promise<void> {
    const samples = Number(values.samples), sessions = values.session ?? [];
    if (!values.connect || !sessions.length || !Number.isInteger(samples) || samples < 1 || samples > 20)
        throw new Error('Expected --connect URL --session ID [--session ID] [--samples 1..20] [--overview]');
    const application = await openCliApplication({connect: values.connect, clientCert: values['client-cert'],
        clientKey: values['client-key'], caCert: values['ca-cert']});
    try {
        for (let sample = 1; sample <= samples; sample++) {
            for (const sessionId of sessions) {
                await measure('session.bind', sample, () => application.client.services.commandBus.execute('session.bind', {sessionId}));
                if (values.overview) {
                    const results = await Promise.allSettled([
                        measure('assistantOverview', sample, () => application.client.backend.assistantOverview!()),
                        measure('session.bind.concurrent', sample, () => application.client.services.commandBus.execute('session.bind', {sessionId})),
                    ]);
                    const failed = results.find(result => result.status === 'rejected');
                    if (failed?.status === 'rejected') throw failed.reason;
                }
            }
        }
    } finally {await application.close();}
}

async function measure(operation: string, sample: number, read: () => Promise<unknown>): Promise<void> {
    const started = performance.now();
    try {
        await read();
        process.stdout.write(JSON.stringify({operation, sample, result: 'success', durationMs: Math.round(performance.now() - started)}) + '\n');
    } catch (error) {
        const code = (error as {code?: unknown})?.code;
        process.stdout.write(JSON.stringify({operation, sample, result: 'failure', durationMs: Math.round(performance.now() - started),
            code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'PROFILE_REQUEST_FAILED'}) + '\n');
        throw error;
    }
}

void main().catch(error => {
    console.error(error instanceof Error && error.message.startsWith('Expected --connect') ? error.message
        : 'Session profile failed; check the failure code above and HTTP connection diagnostics.');
    process.exitCode = 1;
});
