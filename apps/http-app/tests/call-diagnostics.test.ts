import { expect, it } from 'vitest';
import { callDiagnostics, replyDiagnostics } from '../../node-host/src/http/call-diagnostics';

it('records only registered command names and bounded upload metadata', () => {
    const calls = [{target: 'bus', method: 'execute', args: ['app.assets.import', {$object: {url: 'data:image/png;base64,AQID', name: 'private.png'}}]},
        {target: 'bus', method: 'execute', args: ['unregistered-secret', {token: 'private-token'}]}];
    const details = callDiagnostics(calls, ['ICommandBus.execute', 'ICommandBus.execute'], new Set(['app.assets.import']));
    expect(details).toEqual({rpcCommands: ['app.assets.import'], uploads: [{mimeType: 'image/png', bytes: 3}]});
    expect(JSON.stringify(details)).not.toMatch(/AQID|private|secret/);
});

it('distinguishes business errors from HTTP success without logging exception messages', () => {
    expect(replyDiagnostics([{error: {name: 'Error', message: 'private document text', code: 'INPUT_ASSET_PERSISTENCE', remoteCode: 'EACCES'}}, {value: true}]))
        .toEqual({rpcErrorCount: 1, rpcErrorCodes: ['INPUT_ASSET_PERSISTENCE', 'EACCES']});
    expect(replyDiagnostics([{error: {name: 'Error', message: 'secret', code: 'invalid\nprivate'}}])).toEqual({rpcErrorCount: 1, rpcErrorCodes: ['UNCLASSIFIED']});
});
