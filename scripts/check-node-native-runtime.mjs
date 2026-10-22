import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const started = Date.now();
const require = createRequire(resolve(process.argv[2] ?? '.', 'package.json'));
try {
    const Database = require('better-sqlite3'), db = new Database(':memory:');
    try { assert.equal(db.prepare('select 42 as value').get().value, 42); }
    finally { db.close(); }
    assert.equal(typeof require('node-pty').spawn, 'function');
    const sharp = require('sharp');
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } }).png().toBuffer();
    console.log(`[NodeRuntime] stage=native-bindings result=success durationMs=${Date.now() - started} nodeMajor=${process.versions.node.split('.')[0]}`);
} catch (error) {
    console.error(`[NodeRuntime] stage=native-bindings result=failure durationMs=${Date.now() - started} code=${error.code ?? 'NATIVE_BINDING_UNAVAILABLE'} reason=${error.message}`);
    process.exitCode = 1;
}
