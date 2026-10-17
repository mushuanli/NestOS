import type { Call, WireValue } from './protocol';

/** Explicit public capabilities. No implementation fields or prototype traversal. */
export type MethodMode = 'async' | 'query' | 'refresh' | 'iterator' | 'subscribe' | 'async-subscribe' | 'notify' | 'lookup' | 'snapshot';
export type ViewDomain = string;
export interface CapabilitySchema {
    markers: readonly string[];
    fields: readonly string[];
    methods: Readonly<Record<string, MethodMode>>;
    fieldKinds?: Readonly<Record<string, string>>;
    sharedSnapshots?: boolean;
    lazyLookups?: boolean;
    lookupDefaults?: Readonly<Record<string, WireValue>>;
    binary?: boolean;
    transaction?: boolean;
    domain?: ViewDomain;
    invalidates?: readonly ViewDomain[];
    observer?: string | ((value: any, listener: (...events: any[]) => void) => (() => void) | Promise<() => void>);
    scopedObserver?: boolean;
    methodMode?: (call: Call) => MethodMode | undefined;
    snapshotView?: (value: any, name: string) => unknown;
    resultSnapshots?: Readonly<Record<string, string>>;
}

export type CapabilityRegistry = Readonly<Record<string, CapabilitySchema>>;

export function viewDomain(schemas: CapabilityRegistry, kind: string): ViewDomain { return schemas[kind]?.domain ?? 'static'; }
export function affectedDomains(schemas: CapabilityRegistry, kind: string): readonly ViewDomain[] {
    const schema = schemas[kind], domain = viewDomain(schemas, kind);
    return schema?.invalidates ?? (domain === 'static' ? [] : [domain]);
}
export function isViewQuery(schemas: CapabilityRegistry, call: Call, kind: string, mode?: string): boolean {
    return kind !== 'Function' && ['query', 'refresh', 'snapshot', 'lookup'].includes(schemas[kind]?.methodMode?.(call) ?? mode ?? schemas[kind]?.methods[call.method] ?? '');
}

export function subscriptionMode(mode: string | undefined): boolean { return mode === 'subscribe' || mode === 'async-subscribe'; }
