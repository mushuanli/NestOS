import type { ISeqFileTransaction } from '@itookit/vfs-core';
import type { SessionSummary } from './types';

export const NAVIGATION_PATH = '/var/lib/sessions/folders.seq';
export const NAVIGATION_VERSION = 'navigation-version';
export const NAVIGATION_REVISION = 'navigation-revision';
export const navigationPrefix = (folder: string | null) => `navigation/${encodeURIComponent(folder ?? '')}/`;

export function serializeSessionSummary(session: SessionSummary): string {
    const { id, title, summary, origin, createdAt, updatedAt, folder, parentSessionId, createdWithAgentId } = session;
    return JSON.stringify({ id, title, summary, origin, createdAt, updatedAt, folder, parentSessionId, createdWithAgentId });
}

/** Publish directory rows in the same transaction as the authoritative Session metadata. */
export async function indexSessionSummary(tx: ISeqFileTransaction, session: SessionSummary, before?: SessionSummary | null): Promise<void> {
    const location = `navigation-location/${session.id}`;
    const previous = before === undefined ? await tx.getEntry(NAVIGATION_PATH, location)
        : before ? navigationPrefix(before.folder ?? null) + before.id : null;
    const key = navigationPrefix(session.folder ?? null) + session.id;
    if (previous && previous !== key) await tx.deleteEntry(NAVIGATION_PATH, previous);
    await tx.setEntry(NAVIGATION_PATH, key, serializeSessionSummary(session));
    await tx.setEntry(NAVIGATION_PATH, location, key);
    if (await tx.getEntry(NAVIGATION_PATH, NAVIGATION_VERSION) !== '1') {
        const revision = Number(await tx.getEntry(NAVIGATION_PATH, NAVIGATION_REVISION) ?? 0);
        await tx.setEntry(NAVIGATION_PATH, NAVIGATION_REVISION, String(revision + 1));
    }
}

export async function removeSessionSummary(tx: ISeqFileTransaction, id: string): Promise<void> {
    const location = `navigation-location/${id}`;
    const key = await tx.getEntry(NAVIGATION_PATH, location);
    if (key) await tx.deleteEntry(NAVIGATION_PATH, key);
    await tx.deleteEntry(NAVIGATION_PATH, location);
    if (await tx.getEntry(NAVIGATION_PATH, NAVIGATION_VERSION) !== '1') {
        const revision = Number(await tx.getEntry(NAVIGATION_PATH, NAVIGATION_REVISION) ?? 0);
        await tx.setEntry(NAVIGATION_PATH, NAVIGATION_REVISION, String(revision + 1));
    }
}
