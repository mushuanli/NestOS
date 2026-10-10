import type { RecordValue, RecordWalkOptions } from '@itookit/vfs-core';

export type Cell = [] | [RecordValue];
export type Row = { field: string; value: RecordValue };
export interface Page { rows: Row[]; total: number }
export type Observation =
    | { kind: 'get'; requests: { path: string; field: string }[]; values: Cell[] }
    | { kind: 'walk'; path: string; options?: RecordWalkOptions; page: Page };
export type Mutation = { path: string; field: string; value: Cell };
export interface Commit { observations: Observation[]; mutations: Mutation[] }
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
export const MAX_BATCH = 10000;
export const MAX_PAGE = 10000;
