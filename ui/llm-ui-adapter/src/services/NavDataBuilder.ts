// @file: llm-ui/services/NavDataBuilder.ts


import { SessionCommand, SessionGroup, type BranchTreeNode } from '@itookit/llm-session/contracts';
import type { ICommandBus } from '@itookit/llm-session/contracts';
import { ChatNavItem, NavPanelData } from '../domain/ports/INavigationPresenter';
import { BranchItem, CollapseStateMap } from '../domain/types';
import { getPreviewText } from '../utils/textUtils';

/**
 * 导航面板数据构建器
 *
 * 职责：将 SessionManager 的数据转换为 FloatingNavPanel 需要的格式
 * 单一职责：数据转换，不涉及 UI
 */
export class NavDataBuilder {
    constructor(private commands: ICommandBus) { }

    async build(
        sessions: SessionGroup[],
        collapseStates: CollapseStateMap,
        branches: BranchItem[],
        currentSessionId?: string
    ): Promise<NavPanelData> {
        let items: ChatNavItem[];

        try {
            const branchTree = await this.commands.execute<BranchTreeNode>('vcs.branch.tree');
            items = this.buildFromTree(sessions, collapseStates, branchTree);
        } catch (e) {
            console.warn('[NavDataBuilder] Branch tree unavailable, using flat list');
            items = this.buildFlat(sessions, collapseStates);
        }


        try {
            const roundIds = [...new Set(items.map(item => item.roundId).filter(Boolean))];
            const modes = await this.commands.execute<Record<string, 'include' | 'exclude' | 'summary'>>(
                SessionCommand.ContextGet, { roundIds },
            );
            items.forEach(item => { item.contextMode = modes[item.roundId] ?? 'include'; });
        } catch {
            items.forEach(item => { item.contextMode = item.contextMode ?? 'include'; });
        }

        return { items, branches, currentSessionId };
    }

    private buildFromTree(
        sessions: SessionGroup[],
        collapseStates: CollapseStateMap,
        branchTree: BranchTreeNode
    ): ChatNavItem[] {
        const nodeMap = new Map<string, BranchTreeNode>();
        const walk = (node: BranchTreeNode) => {
            nodeMap.set(node.id, node);
            node.children?.forEach(walk);
        };
        walk(branchTree);

        return sessions.map((session, index) => {
            const persistedId = session.persistedNodeId || session.id;
            const treeNode = nodeMap.get(persistedId);

            return {
                id: session.id,
                roundId: session.roundId || persistedId,
                role: session.role,
                preview: getPreviewText(
                    session.content || session.executionRoot?.data.output || '', 30
                ),
                isCollapsed: collapseStates[session.id] ?? false,
                index,
                timestamp: session.timestamp,
                agentName: session.executionRoot?.name,
                branchName: session.branchInfo?.name,
                siblingIndex: session.siblingIndex,
                siblingCount: session.siblingCount,
                hasChildren: (treeNode?.children?.length || 0) > 0,
                memberOfBranches: treeNode?.memberOfBranches || [],
                childBranches: this.extractChildBranches(treeNode),
            };
        });
    }

    private buildFlat(
        sessions: SessionGroup[],
        collapseStates: CollapseStateMap
    ): ChatNavItem[] {
        return sessions.map((session, index) => ({
            id: session.id,
            roundId: session.roundId || session.persistedNodeId || session.id,
            role: session.role,
            preview: getPreviewText(
                session.content || session.executionRoot?.data.output || '', 30
            ),
            isCollapsed: collapseStates[session.id] ?? false,
            index,
            timestamp: session.timestamp,
            agentName: session.executionRoot?.name,
            branchName: session.branchInfo?.name,
            siblingIndex: session.siblingIndex,
            siblingCount: session.siblingCount,
            hasChildren: session.branchInfo?.hasChildren,
            memberOfBranches: session.branchInfo?.name ? [session.branchInfo.name] : [],
        }));
    }

    private extractChildBranches(treeNode: BranchTreeNode | undefined): ChatNavItem['childBranches'] {
        if (!treeNode?.children || treeNode.children.length <= 1) return undefined;

        const branchMap = new Map<string, { name: string; headNodeId: string; isCurrent: boolean }>();
        for (const child of treeNode.children) {
            const branchName = child.memberOfBranches?.[0];
            if (branchName && !branchMap.has(branchName)) {
                branchMap.set(branchName, {
                    name: branchName,
                    headNodeId: child.id,
                    isCurrent: child.isOnActivePath || false,
                });
            }
        }

        return branchMap.size > 1 ? Array.from(branchMap.values()) : undefined;
    }

}
