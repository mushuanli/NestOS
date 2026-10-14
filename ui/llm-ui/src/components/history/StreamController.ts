// @file: llm-ui/components/history/StreamController.ts

import type { SessionRenderer } from './SessionRenderer';
import type { ScrollController } from '../common/ScrollController';
import { getPreviewText } from '../../utils/textUtils';
import type { Citation } from '@itookit/driver-llm/contracts';
import { NodeTemplates } from '../templates/NodeTemplates';

/**
 * 流式输出控制器
 *
 * 核心职责：
 * 1. 收集 chunk，按节奏触发渲染
 * 2. 协调渲染和滚动的时序（两阶段状态机）
 * 3. 管理流式生命周期
 *
 * 架构改进：
 * - 合并了 StreamRenderPipeline 的职责
 * - 单一滚动决策点
 * - 渲染和滚动严格分帧
 */
export class StreamController {
    private isStreaming = false;
    private dirtyNodes = new Set<string>();
    private rafId: number | null = null;
    private lastFlushTime = 0;
    private thoughtScrollThrottled = false;

    // 两阶段状态机
    private phase: 'idle' | 'waitScroll' = 'idle';
    private readonly FLUSH_INTERVAL = 80;

    // 新增：追踪是否刚退出流式模式
    // 用于 HistoryView 在流式结束后短暂保持某些行为
    private _recentlyExited = false;
    private recentlyExitedTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private container: HTMLElement,
        private renderer: SessionRenderer,
        private scrollController: ScrollController
    ) {}

    get isStreamingMode(): boolean {
        return this.isStreaming;
    }

    // 新增 getter
    get recentlyExited(): boolean {
        return this._recentlyExited;
    }

    // ================================================================
    // 生命周期
    // ================================================================

    enter(): void {
        if (this.isStreaming) return;
        this.isStreaming = true;
        this._recentlyExited = false;
        if (this.recentlyExitedTimer !== null) {
            clearTimeout(this.recentlyExitedTimer);
            this.recentlyExitedTimer = null;
        }
        this.phase = 'idle';
        this.container.classList.add('llm-ui-history--streaming');
        this.scrollController.enterStreamingMode();
        this.scheduleFrame();
    }

    exit(): void {
        if (!this.isStreaming) return;
        this.isStreaming = false;
        this.container.classList.remove('llm-ui-history--streaming');

        // 标记为刚退出，一段时间后清除
        this._recentlyExited = true;
        this.recentlyExitedTimer = setTimeout(() => {
            this._recentlyExited = false;
            this.recentlyExitedTimer = null;
        }, 500);

        // 最终 flush
        this.flushAll();

        // 下一微任务做最终滚动
        queueMicrotask(() => {
            this.scrollController.handleContentResize();
        });

        this.cancelFrame();
        this.finalizeAll();
        this.updateAllPreviews();
        this.dirtyNodes.clear();
        this.phase = 'idle';

        this.scrollController.exitStreamingMode();
    }

    // ================================================================
    // 内容更新
    // ================================================================

    replaceContent(nodeId: string, content: string, field: 'thought' | 'output' = 'output'): void {
        if (field === 'thought') {
            const node = this.renderer.getNode(nodeId);
            const text = node?.querySelector('.llm-ui-thought__content');
            const container = node?.querySelector<HTMLElement>('.llm-ui-thought');
            if (text) text.textContent = content;
            if (container) container.style.display = content ? 'block' : 'none';
            return;
        }
        this.renderer.getEditor(nodeId)?.setContent(content);
        this.dirtyNodes.add(nodeId);
    }

    updateContent(nodeId: string, chunk: string, field: 'thought' | 'output'): void {
        const el = this.renderer.getNode(nodeId);
        if (!el) return;

        if (!el.classList.contains('llm-ui-node--streaming')) {
            el.classList.add('llm-ui-node--streaming');
        }

        if (field === 'thought') {
            this.updateThought(el, chunk);
        } else {
            const editor = this.renderer.getEditor(nodeId);
            if (editor) {
                editor.appendDelta(chunk);
                this.dirtyNodes.add(nodeId);
            }
        }
    }

    updateCitations(nodeId: string, citations: Citation[]): void {
        if (!citations.length) return;
        const el = this.renderer.getNode(nodeId);
        if (!el) return;
        const body = el.querySelector('.llm-ui-node__body');
        if (!body) return;
        let sidecar = body.querySelector('.llm-ui-citations') as HTMLElement | null;
        if (!sidecar) {
            sidecar = document.createElement('div');
            sidecar.className = 'llm-ui-citations';
            // 插到 output 容器之前（thinking 之后），符合"引用在上、正文在下"。
            const output = body.querySelector('.llm-ui-node__output');
            if (output) body.insertBefore(sidecar, output);
            else body.appendChild(sidecar);
        }
        sidecar.innerHTML = NodeTemplates.renderCitations(citations);
    }

    updateToolProgress(nodeId: string, progress: import('@itookit/tools/contracts').ToolProgress): void {
        const el = this.renderer.getNode(nodeId);
        if (!el || !['running', 'queued'].includes(el.dataset.status ?? '')) return;
        const activity = el.querySelector<HTMLElement>('.llm-ui-node__progress');
        if (activity) { activity.hidden = false; activity.textContent = progress.message; }
        const result = el.querySelector<HTMLElement>('.llm-ui-node__result');
        if (result && progress.output !== undefined) { result.style.display = 'block'; result.textContent = progress.output; }
    }

    updateStatus(nodeId: string, status: string, result?: any): void {
        const el = this.renderer.getNode(nodeId);
        if (el) {
            el.classList.remove('llm-ui-node--streaming');
            el.dataset.status = status;
            if (!['queued', 'running'].includes(status)) {
                const progress = el.querySelector<HTMLElement>('.llm-ui-node__progress');
                if (progress) progress.hidden = true;
            }
            el.classList.remove(
                'llm-ui-node--running',
                'llm-ui-node--success',
                'llm-ui-node--failed'
            );
            el.classList.add(`llm-ui-node--${status}`);

            const statusText = el.querySelector('.llm-ui-node__status');
            if (statusText) {
                statusText.textContent = status;
                statusText.className = `llm-ui-node__status llm-ui-node__status--${status}`;
            }

            // tool 结果
            if (result !== undefined && el.classList.contains('llm-ui-node--tool')) {
                const resEl = el.querySelector('.llm-ui-node__result') as HTMLElement;
                if (resEl) {
                    resEl.style.display = 'block';
                    resEl.textContent = typeof result === 'string'
                        ? result : JSON.stringify(result, null, 2);
                }
            }

            // 更新预览
            const editor = this.renderer.getEditor(nodeId);
            if (editor) {
                this.updatePreview(nodeId, editor.content);
            }

            this.dirtyNodes.delete(nodeId);
        }

        // 结束编辑器流式
        const editor = this.renderer.getEditor(nodeId);
        if (editor && (status === 'success' || status === 'failed')) {
            editor.finalize();
        }

        // 生成结束后折叠 thinking 面板
        if (el && (status === 'success' || status === 'failed')) {
            this.collapseThought(el);
        }
    }

    private collapseThought(nodeEl: HTMLElement): void {
        const thoughtEl = nodeEl.querySelector('.llm-ui-thought') as HTMLElement | null;
        if (!thoughtEl || thoughtEl.style.display === 'none') return;
        thoughtEl.classList.add('llm-ui-thought--collapsed');
    }

    // ================================================================
    // 帧调度
    // ================================================================

    private scheduleFrame(): void {
        if (this.rafId !== null || !this.isStreaming) return;

        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            if (!this.isStreaming) return;
            this.executeFrame();
            this.scheduleFrame();
        });
    }

    private cancelFrame(): void {
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    private executeFrame(): void {
        switch (this.phase) {
            case 'idle': {
                if (this.dirtyNodes.size === 0) return;

                const now = performance.now();
                const sinceLast = now - this.lastFlushTime;
                if (sinceLast < this.FLUSH_INTERVAL) return;

                // 帧内：执行渲染（DOM write）
                this.flushAll();
                this.lastFlushTime = now;

                // 下一帧：执行滚动
                this.phase = 'waitScroll';
                break;
            }

            case 'waitScroll': {
                // 帧内：执行滚动（DOM read + write）
                this.scrollController.handleContentResize();
                this.phase = 'idle';
                break;
            }
        }
    }

    // ================================================================
    // 渲染操作
    // ================================================================

    private flushAll(): void {
        for (const nodeId of this.dirtyNodes) {
            const editor = this.renderer.getEditor(nodeId);
            if (editor?.hasPending) {
                editor.flush().catch(e => {
                    console.error(`[StreamController] flush failed: ${nodeId}`, e);
                });
            }
        }
    }

    private finalizeAll(): void {
        this.renderer.editors.forEach(editor => {
            editor.finalize().catch(() => {});
        });
    }

    private updateAllPreviews(): void {
        this.renderer.editors.forEach((editor, nodeId) => {
            this.updatePreview(nodeId, editor.content);
        });
    }

    // ================================================================
    // 辅助方法
    // ================================================================

    private updateThought(el: HTMLElement, chunk: string): void {
        const thoughtContainer = el.querySelector('.llm-ui-thought') as HTMLElement;
        const contentEl = el.querySelector('.llm-ui-thought__content') as HTMLElement;

        if (thoughtContainer && thoughtContainer.style.display === 'none') {
            thoughtContainer.style.display = 'block';
        }

        if (contentEl) {
            contentEl.textContent = (contentEl.textContent || '') + chunk;

            if (!this.thoughtScrollThrottled) {
                this.thoughtScrollThrottled = true;
                requestAnimationFrame(() => {
                    this.thoughtScrollThrottled = false;
                    if (thoughtContainer) {
                        thoughtContainer.scrollTop = thoughtContainer.scrollHeight;
                    }
                });
            }
        }
    }

    private updatePreview(nodeId: string, content: string): void {
        const el = this.renderer.getNode(nodeId);
        if (!el) return;
        const previewEl = el.querySelector('.llm-ui-header-preview');
        if (previewEl) {
            previewEl.textContent = getPreviewText(content);
        }
    }

    cleanupNode(nodeId: string): void {
        this.dirtyNodes.delete(nodeId);
    }

    destroy(): void {
        this.cancelFrame();
        this.dirtyNodes.clear();
        this.isStreaming = false;
        this._recentlyExited = false;
        if (this.recentlyExitedTimer !== null) {
            clearTimeout(this.recentlyExitedTimer);
            this.recentlyExitedTimer = null;
        }
        this.phase = 'idle';
    }
}
