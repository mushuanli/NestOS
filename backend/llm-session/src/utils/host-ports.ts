export interface SessionLogger {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
}

export interface SessionHostPorts {
    translate?: (key: SessionTextKey) => string;
    logger?: SessionLogger;
    traceBoot?: <T>(label: string, operation: () => Promise<T>) => Promise<T>;
}

const messages = {
    'chatInput.executionMode.locked': 'The execution mode is locked for this conversation.',
    'chatInput.executionMode.noTools': 'No tools are available for agent execution.',
    'flow.rerun.sessionClosed': 'The session is closed.',
    'flow.rerun.sessionClosing': 'The session is closing.',
    'flow.history.conditionMet': 'Stop condition met',
    'flow.history.roundLimit': 'Round limit reached',
    'flow.history.continue': 'Continue',
};
export type SessionTextKey = keyof typeof messages;
export type SessionHost = Required<SessionHostPorts>;
const noop = () => {};
const silentLogger: SessionLogger = Object.freeze({ debug: noop, info: noop, warn: noop, error: noop });

/** Capture ports for one runtime; later runtimes cannot overwrite them. */
export function createSessionHost(ports: SessionHostPorts = {}): SessionHost {
    return Object.freeze({
        translate: ports.translate ?? t,
        logger: ports.logger ?? silentLogger,
        traceBoot: ports.traceBoot ?? ((_label, operation) => operation()),
    });
}

/** Pure English fallback, also used by standalone persistence helpers. */
export function t(key: SessionTextKey): string { return messages[key]; }
