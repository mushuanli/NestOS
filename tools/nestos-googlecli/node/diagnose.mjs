import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';

/** Read existing runtime logs without opening a profile or running collection. */
export async function diagnose(files, output = console.log) {
    const failures = new Map();
    for (const file of files) {
        const lines = createInterface({input: createReadStream(file), crlfDelay: Infinity});
        for await (const line of lines) {
            const marker = line.indexOf('[GoogleCollection]');
            if (marker < 0 || line.length > 65536) continue;
            let event;
            try {event = JSON.parse(line.slice(marker + '[GoogleCollection]'.length).trim());} catch {continue;}
            if (event.result !== 'failure' || !/^GOOGLE_[A-Z_]+$/.test(event.code ?? '')) continue;
            const key = event.diagnostic?.messageKey;
            const messageKey = typeof key === 'string' && /^[a-f0-9]{64}$/.test(key) ? key : null;
            const group = event.code + ':' + (messageKey ?? 'unavailable');
            const record = failures.get(group) ?? {code: event.code, messageKey, events: 0, operations: new Set()};
            record.events++;
            if (typeof event.operationId === 'string') record.operations.add(event.operationId);
            failures.set(group, record);
        }
    }
    for (const record of failures.values()) output(JSON.stringify({code: record.code, messageKey: record.messageKey,
        failureEvents: record.events, distinctOperations: record.operations.size,
        repeatedMessage: !!record.messageKey && record.operations.size > 1,
        evidence: record.messageKey ? 'message-correlated' : 'insufficient-message-diagnostics'}));
    return failures.size;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
    const files = process.argv.slice(2);
    if (!files.length) {console.error('Usage: node tools/nestos-googlecli/node/diagnose.mjs <runtime.log> [...]'); process.exitCode = 2;}
    else try {await diagnose(files);} catch (error) {
        console.error(JSON.stringify({operation: 'google.diagnose', result: 'failure', code: error.code ?? 'LOG_READ_FAILED'}));
        process.exitCode = 1;
    }
}
