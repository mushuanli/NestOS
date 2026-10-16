import { Agent, request } from 'node:https';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';

export interface ClientIdentity {clientCert?: string; clientKey?: string; caCert?: string}
/** Inject Node mTLS into the portable HTTP client without disabling certificate verification. */
export async function openNodeHttpClient(identity: ClientIdentity) {
    if (!identity.clientCert || !identity.clientKey || !identity.caCert) throw new Error('--connect requires --client-cert, --client-key and --ca-cert');
    const [cert, key, ca] = await Promise.all([identity.clientCert, identity.clientKey, identity.caCert].map(file => readFile(file)));
    const agent = new Agent({cert, key, ca, keepAlive: true});
    const fetcher: typeof fetch = async (input, init = {}) => new Promise((resolve, reject) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.protocol !== 'https:') { reject(new Error('Expected HTTPS')); return; }
        const outgoing = request(url, {agent, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal ?? undefined}, response => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
            resolve(new Response(body, {status: response.statusCode, headers}));
        });
        outgoing.once('error', reject);
        if (init.body instanceof ArrayBuffer) outgoing.write(Buffer.from(init.body));
        else if (ArrayBuffer.isView(init.body)) outgoing.write(Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength));
        else if (init.body !== undefined && init.body !== null) outgoing.write(String(init.body));
        outgoing.end();
    });
    return {fetcher, close: () => agent.destroy()};
}
