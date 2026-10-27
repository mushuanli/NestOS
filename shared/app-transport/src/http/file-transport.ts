import type { RpcPeer } from '../application/peer';
import { RPC_VERSION, type Call, type Reply } from '../rpc/protocol';

/** File bytes travel outside JSON; authorization still uses the view's exported file handle. */
export function installFileTransport(peer: RpcPeer, url: string, clientId: string, abort: AbortSignal, fetcher: typeof fetch,
    disconnected?: (error: unknown) => void): void {
    peer.setFileTransport(async (target, method, args) => {
        const write = method === 'writeContent';
        const options = (write ? args[2] : args[1]) as { signal?: AbortSignal; onRevision?(revision?: string): void } | undefined;
        const call: Call = { target, method, args: await Promise.all(args.map((arg, index) => write && index === 1
            ? Promise.resolve({ $binary: true }) : peer.expose(index === (write ? 2 : 1) && options ? { ...options, onRevision: undefined } : arg))) };
        const content = write ? fileBytes(args[1]) : undefined;
        const response = await fetcher(`${url}/files?clientId=${encodeURIComponent(clientId)}&version=${RPC_VERSION}`, {
            method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-View-Call': encodeURIComponent(JSON.stringify(call)) },
            body: content, signal: options?.signal ? AbortSignal.any([abort, options.signal]) : abort }).catch(error => {
                if (!abort.aborted && !options?.signal?.aborted) disconnected?.(error); throw error;
            });
        if ((response.headers.get('X-NestOS-View-Expired') ?? response.headers.get('X-MindOS-View-Expired')) === '1') disconnected?.(new Error('View expired'));
        if (response.ok && !write) {
            const bytes = await response.arrayBuffer(), header = response.headers.get('X-File-Revision');
            await options?.onRevision?.(header ? JSON.parse(decodeURIComponent(header)) ?? undefined : undefined); return bytes;
        }
        const reply = await response.json() as Reply & { fileRevision?: string };
        if (!response.ok || reply.error) throw Object.assign(new Error(reply.error?.message ?? 'File transfer failed'), reply.error);
        peer.applyUpdates(reply.updates); await peer.waitUpdates(reply.updates);
        await options?.onRevision?.(reply.fileRevision); return peer.decode(reply.value ?? null);
    });
}
function fileBytes(value: unknown): ArrayBuffer {
    if (value instanceof ArrayBuffer) return value;
    const view = value as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}
