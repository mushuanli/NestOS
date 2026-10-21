import { InputAssetCommand } from '@itookit/app-contracts';
import type { Call, Reply } from '@itookit/app-transport/rpc';

/** Only registered command names and bounded upload metadata may enter the audit log. */
export function callDiagnostics(calls: Call[], operations: string[], commands: ReadonlySet<string>) {
    const rpcCommands = calls.flatMap((call, index) => operations[index] === 'ICommandBus.execute'
        && typeof call.args[0] === 'string' && commands.has(call.args[0]) ? [call.args[0]] : []);
    const uploads = calls.flatMap((call, index) => {
        if (operations[index] !== 'ICommandBus.execute' || call.args[0] !== InputAssetCommand.Import) return [];
        const argument = call.args[1] as {$object?: {url?: unknown}; url?: unknown} | undefined;
        const url = (argument?.$object ?? argument)?.url;
        const prefix = typeof url === 'string' && /^data:(image\/[a-z0-9.+-]{1,32});base64,/i.exec(url.slice(0, 128));
        if (!prefix || typeof url !== 'string') return [{mimeType: 'unknown'}];
        const encoded = url.length - prefix[0].length;
        return [{mimeType: prefix[1].toLowerCase(), bytes: Math.max(0, Math.floor(encoded * 3 / 4) - (url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0))}];
    });
    return {...(rpcCommands.length ? {rpcCommands} : {}), ...(uploads.length ? {uploads} : {})};
}

export function replyDiagnostics(replies: Reply[]) {
    const errors = replies.flatMap(reply => reply.error ? [reply.error] : []);
    const rpcErrorCodes = [...new Set(errors.flatMap(error => [error.code, error.remoteCode]
        .filter((code): code is string => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code))))];
    return {rpcErrorCount: errors.length, ...(errors.length ? {rpcErrorCodes: rpcErrorCodes.length ? rpcErrorCodes : ['UNCLASSIFIED']} : {})};
}
