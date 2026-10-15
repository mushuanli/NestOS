import type { UIPersistencePort } from '@itookit/vfs-ui';

/** Restore presentation preferences without turning a saved selection into navigation. */
export function presentationPersistence(port?: UIPersistencePort): UIPersistencePort | undefined {
    if (!port) return undefined;
    return { load: () => {
        const snapshot = port.load?.();
        return snapshot ? { ...snapshot, activeId: null, selectedItemIds: [] } : undefined;
    }, save: snapshot => port.save(snapshot), destroy: () => port.destroy?.() };
}
