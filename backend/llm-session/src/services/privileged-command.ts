// @file: llm-session/services/privileged-command.ts
// Application port for durable privileged commands (plan / exec). Defined here
// so both the UI layer (consumer) and the app shell (adapter) depend on the
// session layer instead of the UI layer.

export interface PlanCommandRequest {
    sessionId: string;
    agentId: string;
    goal: string;
    connectionId?: string;
}

export interface ExecCommandRequest {
    sessionId: string;
    command: string;
}

export interface IPrivilegedCommandService {
    plan(request: PlanCommandRequest): Promise<string>;
    exec(request: ExecCommandRequest): Promise<string>;
}
