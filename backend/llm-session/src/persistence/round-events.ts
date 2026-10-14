// @file: llm-conversation/src/persistence/round-events.ts
// RoundLog → SessionState event stream.
//
// RoundLog emits these events after each mutation. SessionState consumes them
// via apply() as the single state-mutation path, replacing the old manual
// dual-write pattern (engine + state + emit).

import type { RoundId } from '../contracts';
import type { RoundProjection, ToolCallProjection } from './round-types';
import type { NodeStatus } from '../core/types';

export type RoundLogEvent =
    | { type: 'round:appended'; ref: string; roundId: RoundId; projection: RoundProjection }
    | { type: 'round:updated'; roundId: RoundId; changes: RoundChangeSet }
    | { type: 'round:deleted'; roundId: RoundId; cascadeIds?: RoundId[] };

export interface RoundChangeSet {
    assistantContent?: string;
    thinking?: string;
    agentId?: string;
    status?: NodeStatus;
    stale?: boolean;
    _deleted?: boolean;
    /** Tool invocations to surface as assistant execution-tree children. */
    toolCalls?: ToolCallProjection[];
    flowInteractions?: import('../contracts').FlowInteraction[];
    /** Failure reason for a terminal round without assistant output. */
    error?: string;
}
