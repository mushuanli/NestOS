import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {diagnose} from '../node/diagnose.mjs';

test('correlates repeated messages across operations and keeps legacy evidence inconclusive', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'google-diagnose-'));
    try {
        const file = path.join(directory, 'runtime.log'), output = [];
        const events = ['one', 'two'].map(operationId => ({operationId, result: 'failure',
            code: 'GOOGLE_MAIL_BODY_UNAVAILABLE', diagnostic: {messageKey: 'a'.repeat(64)}, secret: 'private'}));
        events.push({result: 'failure', code: 'GOOGLE_MAIL_BODY_UNAVAILABLE'});
        await writeFile(file, events.map(event => '[GoogleCollection] ' + JSON.stringify(event)).join('\n'));
        assert.equal(await diagnose([file], line => output.push(JSON.parse(line))), 2);
        assert.equal(output[0].repeatedMessage, true);
        assert.equal(output[0].distinctOperations, 2);
        assert.equal(output[1].evidence, 'insufficient-message-diagnostics');
        assert.ok(!JSON.stringify(output).includes('private'));
    } finally {await rm(directory, {recursive: true, force: true});}
});
