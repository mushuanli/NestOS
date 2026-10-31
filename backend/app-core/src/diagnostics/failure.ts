/** Classify causes without returning native messages, URLs, response bodies or stacks. */
export function diagnosticFailure(error: unknown): {code: string; causeCodes: string[]; reason: string; requestId?: string} {
    const codes: string[] = [], seen = new Set<unknown>();
    let reason = 'unknown', requestId: string | undefined;
    for (let depth = 0; depth < 8 && error && typeof error === 'object' && !seen.has(error); depth++) {
        seen.add(error);
        const value = error as {code?: unknown; remoteCode?: unknown; name?: string; message?: string; cause?: unknown; requestId?: unknown; timedOut?: boolean};
        for (const code of [value.code, value.remoteCode]) if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)) codes.push(code);
        if (typeof value.requestId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value.requestId)) requestId ??= value.requestId;
        const detail = `${value.code} ${value.name} ${value.message}`;
        if (value.timedOut || /timeout|timed out|ETIMEDOUT/i.test(detail)) reason = 'timeout';
        else if (/authorization changed|AUTHORIZATION_CHANGED|grant.*revision/i.test(detail)) reason = 'authorization-changed';
        else if (/401|403|EACCES|EACCESS|unauthori[sz]ed|authentication|credential/i.test(detail)) reason = 'authentication';
        else if (/ECONN|ENOTFOUND|fetch|network|ENET|EHOST/i.test(detail)) reason = 'network';
        else if (/ECONFLICT|revision|binding/i.test(detail)) reason = 'binding-changed';
        else if (/ENOENT|ENOTDIR|not found/i.test(detail)) reason = 'not-found';
        else if (value.code === 'EBUSY' || value.remoteCode === 'EBUSY') reason = 'busy';
        error = value.cause;
    }
    return {code: codes[0] ?? (reason === 'timeout' ? 'ETIMEDOUT' : reason === 'network' ? 'NETWORK_ERROR' : 'REMOTE_OPERATION_FAILED'),
        causeCodes: [...new Set(codes.slice(1))], reason, ...(requestId ? {requestId} : {})};
}
