// @file: llm-ui/domain/ports/ICollapseManager.ts

import type { CollapseStateMap } from '../types';

/** Focused interface for collapse/expand state — extracted from IHistoryPresenter (ISP). */
export interface ICollapseManager {
    getCollapseStates(): CollapseStateMap;
    resetCollapseStates(): void;
    toggleSessionCollapse(sessionId: string, forceState?: boolean): void;
    setAllCollapsed(collapsed: boolean): void;
    toggleAllFold(): boolean;
    shouldShowCollapseIcon(): boolean;
    foldCurrentUnfolded(): void;
}
