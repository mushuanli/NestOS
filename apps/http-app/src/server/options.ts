import { parseArgs } from 'node:util';

export function options(args = process.argv.slice(2)) {
    return parseArgs({ args, options: {
        root: { type: 'string' }, sidecar: { type: 'string' }, host: { type: 'string', default: '0.0.0.0' },
        port: { type: 'string', default: '2000' },
        backlog: { type: 'string', default: '4096' },
        static: { type: 'string' }, 'cert-dir': { type: 'string' }, 'cert-host': { type: 'string' },
        'init-certs': { type: 'boolean' }, 'audit-file': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    } }).values;
}
