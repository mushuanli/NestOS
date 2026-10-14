// @file: llm-ui/components/history/NodeRenderer.ts

import { escapeHTML, FEEDBACK_ICONS, t } from '@itookit/common';
import { ExecutionNode } from '@itookit/llm-session/contracts';
import { NodeTemplates } from '../templates/NodeTemplates';
import { IconResolver } from '../../utils/iconResolver';

export interface RenderResult {
    element: HTMLElement;
    mountPoints: {
        output?: HTMLElement;
    };
}

export class NodeRenderer {
    static create(node: ExecutionNode): RenderResult {
        const el = document.createElement('div');

        // 使用共享 IconResolver
        const icon = IconResolver.getIcon(node);
        const layoutClass = IconResolver.getLayoutClass(node);

        el.className = `llm-ui-node llm-ui-node--${node.executorType} ${layoutClass}`;
        el.dataset.id = node.id;
        el.dataset.title = node.name;
        el.dataset.status = node.status;
        if (node.messageRole) el.dataset.role = node.messageRole;

        const mountPoints: { output?: HTMLElement } = {};

        if (node.executorType === 'agent' || node.executorType === 'composite') {
            this.renderAgent(el, node, mountPoints, icon);
        } else if (node.executorType === 'tool') {
            el.innerHTML = NodeTemplates.renderTool(node, icon);
        } else {
            this.renderAgent(el, node, mountPoints, icon);
        }

        return { element: el, mountPoints };
    }

    static renderRequests(requests?: unknown[]): string {
        return `<details class="llm-ui-node__req"><summary>req</summary><pre>${escapeHTML(requests?.length ? JSON.stringify(requests, null, 2) : t('flow.history.noRequest'))}</pre></details>`;
    }

    private static renderAgent(
        el: HTMLElement,
        node: ExecutionNode,
        mounts: any,
        icon: string
    ): void {
        const hasThought = !!(node.data.thought && node.data.thought.length > 0);
        const previewText = node.data.output
            ? node.data.output.substring(0, 50).replace(/\n/g, ' ')
            : '';

        // A cancelled (projected as `aborted`) node carries the same terminal reason as a
        // failed one, and dropping it left an unexplained empty bubble after a reload.
        const errorHtml = (node.status === 'failed' || node.status === 'aborted') && node.data.error
            ? `<div class="llm-ui-node__error-embed">${FEEDBACK_ICONS.warning} ${escapeHTML(node.data.error)}</div>`
            : '';

        // 传入折叠状态
        const isCollapsed = false; // 由调用方在 appendNode 中设置

        el.innerHTML = `
            ${NodeTemplates.renderAgentHeader(node, previewText, icon, isCollapsed)}
            <div class="llm-ui-node__body">
                ${node.data.metaInfo?.actor?.kind === 'tool' && node.data.input !== undefined
                    ? `<details class="llm-ui-node__input"><summary>${escapeHTML(node.name)}</summary><pre>${escapeHTML(typeof node.data.input === 'string' ? node.data.input : JSON.stringify(node.data.input, null, 2))}</pre></details>` : ''}
                ${node.data.metaInfo?.flowInteraction && node.data.metaInfo?.actor?.kind !== 'tool' ? NodeRenderer.renderRequests(node.data.metaInfo?.requests) : ''}
                ${NodeTemplates.renderThinking(node.data.thought || '', hasThought, node.status)}
                ${errorHtml}
                <div class="llm-ui-node__output">
                    <div class="llm-ui-mount-point" id="mount-${node.id}"></div>
                </div>
                <div class="llm-ui-node__tty-panels"></div>
                <div class="llm-ui-node__children"></div>
            </div>
        `;

        mounts.output = el.querySelector(`#mount-${node.id}`);
    }
}
