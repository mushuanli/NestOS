// ISession — Channel primitive: session as process.
//
// The full API surface of a session reduces to two methods:
//   signal()  — inbound mailbox (send / abort / inject / respond / navigate)
//   events()  — outbound event stream (canonical AgentEvent)
//
// All higher-level operations (branch management, export, settings, etc.)
// are exposed as plugin-contributed commands via ICommandBus.
//
// Design reference: Unix process model (stdin/signals/stdout), Actor mailbox,
// Elm architecture (view = f(state)).

import type { AgentEvent } from '@itookit/llm-tasks/contracts';
import type { Signal } from './conversation';

export interface ISession {
    readonly id: string;
    /** Inbound mailbox — all user interaction reduces to signals. */
    signal(s: Signal): void;
    /** Outbound event stream — UI projects state from this. */
    events(): AsyncIterable<AgentEvent>;
}
