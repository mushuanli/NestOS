// @vitest-environment jsdom
/**
 * TTY 面板契约：输出以文本节点写入（不得注入 HTML）、终态后不再接收输出、
 * 退出码 0/非 0/未知必须可区分，且 `TtyController` 只把 meta 路由到匹配的会话。
 * jsdom 环境由 app-shell 提供（llm-ui 的 vitest 无 jsdom）。
 */
import { expect, it } from 'vitest';
import { t } from '@itookit/common';
import { TtyPanel } from '../../llm-ui/src/components/tty/TtyPanel';
import { TtyController } from '../../llm-ui/src/components/tty/TtyController';

function node(): HTMLElement {
    const el = document.createElement('div');
    el.innerHTML = '<div class="llm-ui-node__tty-panels"></div>';
    document.body.append(el);
    return el;
}

it('writes the command and output as text, never as markup', () => {
    const host = node();
    const panel = new TtyPanel(host, 'tty-1', 'echo <script>alert(1)</script>', 42);
    const cmd = host.querySelector<HTMLElement>('.llm-ui-tty-panel__cmd')!;
    expect(cmd.textContent).toContain('<script>alert(1)</script>');
    expect(cmd.querySelector('script')).toBeNull();

    panel.appendOutput('<img src=x onerror=alert(1)>');
    const output = host.querySelector<HTMLElement>('.llm-ui-tty-panel__output')!;
    expect(output.querySelector('img')).toBeNull();
    expect(output.textContent).toBe('<img src=x onerror=alert(1)>');
});

it('finalizes once and ignores output that arrives afterwards', () => {
    const host = node();
    const panel = new TtyPanel(host, 'tty-2', 'echo done', undefined);
    panel.appendOutput('done\n');
    panel.finalize(0);
    panel.finalize(3);
    expect(host.querySelectorAll('.llm-ui-tty-panel__exit-info')).toHaveLength(1);

    expect(host.querySelector('.llm-ui-tty-panel__status')?.textContent).toBe(t('tty.status.exited'));
    expect(host.querySelector('.llm-ui-tty-panel__exit-info')?.textContent).toBe(t('tty.exit.known', { code: 0 }));

    panel.appendOutput('late chunk');
    expect(host.querySelector('.llm-ui-tty-panel__output')?.textContent).toBe('done\n');
});

it('reports a non-zero code as such and an unobserved exit as unknown', () => {
    const failed = node();
    new TtyPanel(failed, 'tty-3', 'false', undefined).finalize(3);
    expect(failed.querySelector('.llm-ui-tty-panel__exit-info')?.textContent).toBe(t('tty.exit.known', { code: 3 }));

    // `tty_close` emits `exitCode: null` when the session has no observed code (e.g. killed by a
    // signal); claiming a code — even "?" — would misreport how the process ended.
    const stopped = node();
    new TtyPanel(stopped, 'tty-4', 'sleep 10', undefined).finalize(null);
    expect(stopped.querySelector('.llm-ui-tty-panel__exit-info')?.textContent).toBe(t('tty.exit.unknown'));
});

it('keeps only the newest output when the panel exceeds its bound', () => {
    const host = node();
    const panel = new TtyPanel(host, 'tty-5', 'yes', undefined);
    panel.appendOutput('a'.repeat(100_001));
    const text = host.querySelector<HTMLElement>('.llm-ui-tty-panel__output')!.textContent!;
    expect(text).toHaveLength(100_000);
    expect(text.startsWith('a')).toBe(true);
});

it('routes open/data/close meta to the matching panel only', () => {
    const host = node();
    const controller = new TtyController(() => host);
    controller.handleMeta('node-1', { ttyOpen: { sessionId: 'a', command: 'cat', pid: 7 } });
    controller.handleMeta('node-1', { ttyOpen: { sessionId: 'a', command: 'cat' } }); // idempotent
    controller.handleMeta('node-1', { ttyData: { sessionId: 'a', chunk: 'hello' } });
    controller.handleMeta('node-1', { ttyData: { sessionId: 'other', chunk: 'ignored' } });

    expect(host.querySelectorAll('.llm-ui-tty-panel')).toHaveLength(1);
    expect(host.querySelector('.llm-ui-tty-panel__output')?.textContent).toBe('hello');

    controller.handleMeta('node-1', { ttyClose: { sessionId: 'a', exitCode: 3 } });
    expect(host.querySelector('.llm-ui-tty-panel__exit-info')?.textContent).toBe(t('tty.exit.known', { code: 3 }));

    controller.destroyAll();
    expect(host.querySelector('.llm-ui-tty-panel')).toBeNull();
});
