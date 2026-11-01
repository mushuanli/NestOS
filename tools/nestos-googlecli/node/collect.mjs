import {fail, googleClient} from './client.mjs';
import {saveMaterials} from './materials.mjs';
import {openSync, commitSync, freezeDestination, collectionDirectory} from './sync-store.mjs';
import {readBatch} from './sync-batch.mjs';
import {mailSync} from './mail-sync.mjs';
import {calendarSync} from './calendar-sync.mjs';

export async function collectGoogle(service, args, context, connections, fetcher = fetch) {
    const started = Date.now(); let stage = 'authorization', directory;
    const report = async (result, code, count, progress) => {
        const event = {operation: 'google.' + service + '.collect', operationId: context.operationId, stage, result, code, count,
            diagnostic: progress?.diagnostic, mimeType: progress?.mimeType, complete: progress?.complete, processed: progress?.processed, directory, cwd: context.cwd, durationMs: Date.now() - started};
        try {console[result === 'failure' ? 'warn' : 'info']('[GoogleCollection]', JSON.stringify(event));} catch {}
        try {await context.onProgress?.({message: JSON.stringify(event)});} catch {}
    };
    try {
        const signal = AbortSignal.any([context.signal ?? new AbortController().signal, AbortSignal.timeout(120000)]);
        context = {...context, signal, report, batchDeadline: started + 45000};
        const client = await googleClient(connections, args.connection, signal, fetcher);
        stage = 'destination'; args = await freezeDestination(service, args, client, context);
        directory = collectionDirectory(service, args);
        stage = 'checkpoint'; const sync = await openSync(service, args, context);
        if (sync.receipt) {signal.throwIfAborted(); await report('replayed', undefined, sync.receipt.count, sync.receipt.collection); return sync.receipt;}
        stage = 'fetch';
        const provider = service === 'gmail' ? await mailSync(client, args, context, sync.directory, {account: sync.account}) : calendarSync(client, args, context, sync.directory);
        const batch = await readBatch(provider, sync.state, args, context);
        stage = 'connection-check'; await client.verifyConnection();
        stage = 'persist'; const saved = await saveMaterials(batch.items, args, context, service);
        const result = {...saved, complete: batch.complete, collection: {version: 1, complete: batch.complete, processed: batch.state.processed, batchCount: saved.count}};
        stage = 'checkpoint-commit'; await commitSync(sync, batch.state, result, context, client);
        await report(batch.complete ? 'success' : 'pending', undefined, saved.count, result.collection); return result;
    } catch (error) {
        const code = context.signal?.aborted ? context.signal.reason?.name === 'TimeoutError' ? 'GOOGLE_COLLECTION_TIMEOUT' : 'GOOGLE_CANCELLED'
            : /^(GOOGLE_|TOOL_CONNECTION_|TOOL_AUTH_|RESOURCE_)[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'GOOGLE_COLLECTION_FAILED';
        await report('failure', code, undefined, {diagnostic: error.diagnostic, mimeType: error.diagnostic?.mimeType}); throw fail(code);
    }
}
