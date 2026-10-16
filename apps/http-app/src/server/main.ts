import { runHttpHost } from '@itookit/node-host/http';
import { fileURLToPath } from 'node:url';
const staticDir = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../../dist/' : '../dist/', import.meta.url));
runHttpHost(process.argv.slice(2), staticDir).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
