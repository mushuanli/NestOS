// @file: llm-ui/components/input/plugins/TokenMeterPlugin.ts
//
// TokenMeterPlugin — 在输入框下方显示 token 用量与上下文窗口消耗。
//
// 显示内容（单行，紧凑）：
//   ↑ 12.4K  ↓ 3.2K  $0.082  Context ████████░░ 81%  ·  3 轮  ·  2.3s  ~
//        ↑ isEstimated 时显示 ~ 表示估算
//
// 颜色编码（Context 进度条）：
//   < 60%  → 静默（muted，不打扰用户）
//   60-80% → 琥珀色警告
//   > 80%  → 红色危险
//
// 更新时机：
//   - 任务完成后（Shell 调用 chatInput.updateTokenStats(stats)）
//   - 切换会话时（传 null 重置）

import type { InputPlugin, InputPluginContext } from './InputPlugin';
import type { TokenStats } from '../../../domain/types';
import { injectStyle } from '../../../utils/styleInjector';

const BAR_BLOCKS = 10;

/** 格式化 token 数为简短字符串（1234 → 1.2K，12345 → 12K） */
function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000)    return `${Math.round(n / 1_000)}K`;
    if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

/** 格式化 USD 费用（0.00082 → $0.001，0.082 → $0.082） */
function fmtCost(usd: number): string {
    if (usd === 0) return '$0';
    if (usd < 0.001) return `<$0.001`;
    if (usd < 0.01)  return `$${usd.toFixed(3)}`;
    if (usd < 1)     return `$${usd.toFixed(2)}`;
    return `$${usd.toFixed(1)}`;
}

/** 格式化毫秒为秒（1234 → 1.2s，12345 → 12s） */
function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 1000)}s`;
}

/** 渲染上下文窗口进度条（Unicode block chars） */
function renderBar(ratio: number): { bar: string; colorClass: string } {
    const filled  = Math.round(ratio * BAR_BLOCKS);
    const empty   = BAR_BLOCKS - filled;
    const bar     = '█'.repeat(filled) + '░'.repeat(empty);
    const pct     = Math.round(ratio * 100);
    const colorClass = ratio >= 0.80 ? 'danger'
                     : ratio >= 0.60 ? 'warn'
                     : 'ok';
    return { bar: `${bar} ${pct}%`, colorClass };
}

export class TokenMeterPlugin implements InputPlugin {
    readonly id = 'token-meter';
    readonly priority = 20; // above kernel(10) won't conflict, just for ordering

    private ctx: InputPluginContext | null = null;
    private strip: HTMLElement | null = null;
    private stats: TokenStats | null = null;

    activate(ctx: InputPluginContext): void {
        this.ctx = ctx;
        this.injectStyles();
    }

    /** Called by ChatInput.updateTokenStats() */
    update(stats: TokenStats | null): void {
        this.stats = stats;
        this.render();
    }

    deactivate(): void {
        this.strip?.remove();
        this.strip = null;
        this.ctx = null;
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private ensureStrip(): HTMLElement {
        if (!this.strip) {
            this.strip = document.createElement('div');
            this.strip.className = 'token-meter';
            this.strip.style.display = 'none';

            // Insert inside .llm-input__toolbar-right, before the settings button,
            // so token stats share the toolbar row instead of occupying a full row.
            const toolbarRight = this.ctx!.container.querySelector('.llm-input__toolbar-right');
            const settingsBtn  = toolbarRight?.querySelector('.llm-input__btn--settings');
            if (toolbarRight && settingsBtn) {
                toolbarRight.insertBefore(this.strip, settingsBtn);
            } else {
                // Fallback: append to main (original behavior)
                const main = this.ctx!.container.querySelector('.llm-input__main') ?? this.ctx!.container;
                main.appendChild(this.strip);
            }
        }
        return this.strip;
    }

    private render(): void {
        const strip = this.ensureStrip();

        if (!this.stats) {
            strip.style.display = 'none';
            return;
        }

        const s = this.stats;
        const { bar, colorClass } = renderBar(s.contextUsageRatio);
        const est = s.isEstimated ? '<span class="token-meter__est" title="Estimated from content length">~</span>' : '';

        const totalOut = fmtTokens(s.inputTokens + s.outputTokens);
        const inTok  = fmtTokens(s.inputTokens);
        const outTok = fmtTokens(s.outputTokens);
        const cost   = fmtCost(s.costUsd);
        const dur    = fmtDuration(s.durationMs);

        const cachePart = (s.cacheReadTokens ?? 0) > 0
            ? ` <span class="token-meter__cache" title="Cache hit tokens">⚡${fmtTokens(s.cacheReadTokens!)}</span>`
            : '';

        const roundsPart = s.rounds > 1
            ? `<span class="token-meter__sep">·</span><span title="${s.rounds} rounds">${s.rounds} rounds</span>`
            : '';

        strip.style.display = 'flex';
        strip.innerHTML = `
            <span class="token-meter__tokens" title="Total tokens: ${s.inputTokens + s.outputTokens}">
                <span class="token-meter__arrow token-meter__arrow--in" title="Input tokens">↑</span>${inTok}
                <span class="token-meter__arrow token-meter__arrow--out" title="Output tokens">↓</span>${outTok}
                ${cachePart}
            </span>
            <span class="token-meter__sep">·</span>
            <span class="token-meter__cost" title="Estimated cost">${cost}${est}</span>
            <span class="token-meter__sep">·</span>
            <span class="token-meter__ctx token-meter__ctx--${colorClass}"
                  title="Context window usage: ${Math.round(s.contextUsageRatio * 100)}% of ~200K tokens">
                <span class="token-meter__ctx-label">Ctx</span>
                <span class="token-meter__bar">${bar}</span>
            </span>
            ${roundsPart}
            <span class="token-meter__sep">·</span>
            <span class="token-meter__dur" title="Generation time">${dur}</span>
            <span class="token-meter__total" style="display:none" aria-label="Total tokens: ${totalOut}"></span>
        `;
    }

    private injectStyles(): void {
        injectStyle('token-meter-styles', `
/* ── Token Meter — inline in toolbar-right ─────────────────────────────── */
.token-meter {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 6px;
    font-size: 11px;
    color: var(--text-tertiary, #aaa);
    flex-wrap: nowrap;
    overflow: hidden;
    white-space: nowrap;
    user-select: none;
    /* Separator from toolbar-left via flex spacer in toolbar */
    border-right: 1px solid var(--border-color-subtle, #eee);
    margin-right: 2px;
    max-width: 280px;
    flex-shrink: 1;
    min-width: 0;
}
.token-meter__sep { opacity: 0.35; flex-shrink: 0; }
.token-meter__arrow { font-size: 10px; margin-right: 1px; opacity: 0.7; }
.token-meter__arrow--in  { color: var(--accent, #1967d2); }
.token-meter__arrow--out { color: var(--color-orange, #e67e22); }
.token-meter__tokens { display: flex; align-items: center; gap: 2px; flex-shrink: 1; min-width: 0; }
.token-meter__cache { color: var(--color-green, #27ae60); margin-left: 3px; }
.token-meter__cost { font-weight: 500; color: var(--text-secondary, #666); flex-shrink: 0; }
.token-meter__est { opacity: 0.6; font-size: 9px; vertical-align: super; cursor: help; }

/* Context bar */
.token-meter__ctx { display: flex; align-items: center; gap: 3px; flex-shrink: 0; }
.token-meter__ctx-label { opacity: 0.6; font-size: 10px; }
.token-meter__bar {
    font-family: monospace;
    letter-spacing: -1px;
    font-size: 10px;
    transition: color .3s;
}
.token-meter__ctx--ok     .token-meter__bar { color: var(--text-tertiary, #bbb); }
.token-meter__ctx--warn   .token-meter__bar { color: #e67e22; }
.token-meter__ctx--danger .token-meter__bar { color: #e74c3c; }
.token-meter__ctx--warn   { color: #e67e22; }
.token-meter__ctx--danger { color: #e74c3c; animation: token-pulse 1.5s ease-in-out infinite; }

.token-meter__dur { opacity: 0.6; flex-shrink: 0; }

@keyframes token-pulse {
    0%,100% { opacity: 1; }
    50%      { opacity: 0.6; }
}

/* Narrow toolbar: progressively hide lower-priority items */
@media (max-width: 640px) {
    .token-meter__dur { display: none; }
    .token-meter__cost { display: none; }
}
@media (max-width: 480px) {
    /* Only show context bar on very small screens */
    .token-meter__tokens { display: none; }
    .token-meter .token-meter__sep { display: none; }
}
`);
    }

// injectStyles now uses shared injectStyle utility from utils/styleInjector.ts
}
