import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeUuidCalls} from '../check-browser-uuid.mjs';

test('rejects native calls including optional and indexed access, without matching comments', () => {
    assert.deepEqual(nativeUuidCalls('// crypto.randomUUID()\ncrypto.randomUUID();\nglobalThis.crypto?.randomUUID?.();\ncrypto["randomUUID"]();'), [2, 3, 4]);
    assert.deepEqual(nativeUuidCalls('import {randomUUID} from "@itookit/common";\nrandomUUID();'), []);
});
