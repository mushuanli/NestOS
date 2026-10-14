import { ENTITY_ICONS, STATUS_META, escapeAttr, t } from '@itookit/common';
import type { MCPConnectionState } from '@itookit/tools/mcp-contracts';

export function mcpStatusIcon(custom: Record<string, unknown>): string {
    const state = custom.mcpConnectionState as MCPConnectionState | undefined;
    const raw = state?.status ?? custom.mcpStatus;
    const status = typeof raw === 'string' && Object.hasOwn(STATUS_META, raw) ? raw as MCPConnectionState['status'] : 'idle';
    const detail = [t(`mcp.state.${status}`), ...(state?.issues ?? []).map(issue =>
        `${t(`mcp.stage.${issue.stage}`)}: ${t(`mcp.failure.${issue.reason}`)}`)];
    if (state?.checkedAt) detail.push(t('mcp.state.observedAt', {time: new Date(state.checkedAt).toLocaleString()}));
    const description = escapeAttr(detail.join('\n'));
    return `<span class="mcp-status-icon" title="${description}" aria-label="${description}">${ENTITY_ICONS.mcp}<span class="mcp-status-icon__badge" style="color:${STATUS_META[status].color}" aria-hidden="true">${STATUS_META[status].dot}</span></span>`;
}
