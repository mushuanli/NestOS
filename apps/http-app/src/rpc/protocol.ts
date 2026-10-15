export type WireValue = null | boolean | number | string | WireValue[] | { [key: string]: WireValue };
export interface Call { target: string; method: string; args: WireValue[]; notification?: boolean; released?: string[] }
export interface Reply { value?: WireValue; updates?: WireValue[]; error?: { name: string; message: string; code?: string } }
export interface CallbackRequest { id?: string; call: Call }
export interface Descriptor { id: string; kind: string; version?: number; fields: Record<string, WireValue>; snapshots: Record<string, WireValue>; lookups: Record<string, WireValue> }
export const RPC_VERSION = 5;
export const MAX_RPC_HANDLES = 4096;
