// @file: llm-ui/domain/ports/INavigationPresenter.ts

import type { BranchItem } from '../types';

export interface ChatNavItem {
    id: string;
    roundId: string;
    role: 'user' | 'assistant';
    preview: string;
    isCollapsed: boolean;
    index: number;
    timestamp: number;
    agentName?: string;
    branchName?: string;
    siblingIndex?: number;
    siblingCount?: number;
    hasChildren?: boolean;
    // 该节点所属的所有 branch 名称（用于筛选和删除判断）
    memberOfBranches?: string[];
    childBranches?: Array<{
        name: string;
        headNodeId: string;
        isCurrent: boolean;
    }>;
    contextMode?: 'include' | 'exclude' | 'summary';
}

export interface NavPanelData {
    items: ChatNavItem[];
    branches: BranchItem[];
    currentSessionId?: string;
}

export interface INavigationPresenter {
    readonly isVisible: boolean;
    toggle(): void;
    update(data: NavPanelData): void;
    destroy(): void;
}
