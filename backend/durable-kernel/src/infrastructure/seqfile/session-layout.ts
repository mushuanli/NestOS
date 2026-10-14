import type { SessionLayout, SessionRecord } from '../../domain/types';

/** Durable storage layout this host writes and understands (Storage §5). */
export const SESSION_LAYOUT_VERSION = 1;

/**
 * Capabilities the built-in SeqFile implementation provides. A Session that declares a
 * requirement outside this set was written by a host with features this one lacks, so
 * opening it must fail instead of silently ignoring the missing guarantee.
 */
const IMPLEMENTED_CAPABILITIES: ReadonlySet<string> = new Set([
    'transactional-seq', 'atomic-cas', 'shared-state', 'effect-receipts', 'cache', 'messages',
]);

/** Manifest written into every new Session record. */
export function currentSessionLayout(): SessionLayout {
    return {
        layoutVersion: SESSION_LAYOUT_VERSION,
        recordSchemas: { attempt: 1, cache: 1, effect: 1, events: 1, graph: 1, index: 1, messages: 1, resources: 1, shared: 1, task: 1 },
        requiredCapabilities: [...IMPLEMENTED_CAPABILITIES].sort(),
        migration: { status: 'complete', to: SESSION_LAYOUT_VERSION },
    };
}

/**
 * Refuse a Session this host cannot interpret: a newer layout, an interrupted migration,
 * or an unsupported required capability. Legacy records without a manifest stay readable.
 */
export function assertSessionLayout(record: SessionRecord): void {
    const layout = record.layout;
    if (layout === undefined) return;
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new Error('Invalid Session layout manifest');
    if (!Number.isSafeInteger(layout.layoutVersion) || layout.layoutVersion < 1) {
        throw new Error(`Invalid Session layout version: ${String(layout.layoutVersion)}`);
    }
    if (layout.layoutVersion > SESSION_LAYOUT_VERSION) {
        throw new Error(`Unsupported Session layout version ${layout.layoutVersion}`
            + ` (this host supports ≤ ${SESSION_LAYOUT_VERSION})`);
    }
    assertMigration(layout);
    assertRecordSchemas(layout.recordSchemas);
    if (!Array.isArray(layout.requiredCapabilities)) throw new Error('Invalid Session required capabilities');
    for (const capability of layout.requiredCapabilities ?? []) {
        if (!IMPLEMENTED_CAPABILITIES.has(capability)) {
            throw new Error(`Session requires unsupported storage capability '${capability}'`);
        }
    }
}

function assertMigration(layout: SessionLayout): void {
    const migration = layout.migration;
    if (migration?.status === 'pending') throw new Error('Session layout migration is pending');
    if (!migration || !['none', 'complete'].includes(migration.status)
        || migration.to !== layout.layoutVersion) throw new Error('Invalid Session layout migration');
}

function assertRecordSchemas(schemas: SessionLayout['recordSchemas']): void {
    if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) throw new Error('Invalid Session record schemas');
    const supported = currentSessionLayout().recordSchemas;
    for (const [family, version] of Object.entries(schemas)) {
        if (!Object.hasOwn(supported, family) || version !== supported[family]) {
            throw new Error(`Unsupported Session record schema '${family}': ${String(version)}`);
        }
    }
    for (const family of Object.keys(supported)) {
        if (!Object.hasOwn(schemas, family)) throw new Error(`Missing Session record schema '${family}'`);
    }
}
