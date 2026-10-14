/** Host-owned presentation state; file content stays in its filesystem. */
export interface WorkbenchSnapshot {
    version: 1;
    width?: number;
    navigationHeight?: number;
    navigationCollapsed?: boolean;
    openedCollapsed?: boolean;
    tabs?: { id: string; title: string; pinned: boolean }[];
}
export interface WorkbenchStatePort {
    load(): WorkbenchSnapshot | undefined;
    save(snapshot: WorkbenchSnapshot): void;
}
export function readWorkbenchSnapshot(value: unknown): WorkbenchSnapshot | undefined {
    if (!value || typeof value !== 'object') return;
    const data = value as WorkbenchSnapshot;
    if (data.version !== 1) return;
    const tabs = Array.isArray(data.tabs) ? data.tabs.filter(tab => tab && typeof tab.id === 'string' && typeof tab.title === 'string' && typeof tab.pinned === 'boolean') : [];
    const number = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : undefined;
    return { version: 1, width: number(data.width, 220, 600), navigationHeight: number(data.navigationHeight, 20, 85),
        navigationCollapsed: data.navigationCollapsed === true, openedCollapsed: data.openedCollapsed === true, tabs };
}
