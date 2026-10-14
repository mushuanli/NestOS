export type SandboxBackend = 'seatbelt' | 'bubblewrap';

/** Host-owned grants. Paths must be canonical, absolute native paths, not VFS paths. */
export interface SandboxPolicy {
    readOnlyPaths?: readonly string[];
    writablePaths?: readonly string[];
    network?: 'deny' | 'allow';
}

export interface SandboxCommand {
    command: string;
    args?: readonly string[];
    cwd: string;
    /** Explicit child environment only; never merged with the host environment. */
    env?: Readonly<Record<string, string>>;
}

/** Execute with argv and a replaced environment, never through a host shell. */
export interface SandboxLaunchPlan {
    backend: SandboxBackend;
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
}

export class SandboxError extends Error {
    constructor(readonly code: 'INVALID_POLICY' | 'UNSUPPORTED_PLATFORM' | 'UNAVAILABLE', message: string) {
        super(message);
        this.name = 'SandboxError';
    }
}
