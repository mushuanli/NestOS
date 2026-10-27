#!/usr/bin/env node
import {readFileSync} from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version' || args[0] === '-v') {
    console.log(manifest.version);
} else {
    if (['httpd', 'start'].includes(args[0])) args.shift();
    if (args[0] === 'init-certs') args.splice(0, 1, '--init-certs');
    process.argv = [process.argv[0], process.argv[1], ...args];
    process.env.MINDOS_HTTPD_MODE ??= 'release';
    const release = JSON.parse(readFileSync(new URL('../release.json', import.meta.url), 'utf8'));
    process.env.MINDOS_HTTPD_VERSION ??= `${manifest.version}+${release.id}`;
    await import('../server/main.js');
}
