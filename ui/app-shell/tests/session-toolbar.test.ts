// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installResponsiveActions } from '@itookit/ui-common';
import { SessionFamilyActions } from '../src/projects/SessionFamilyActions';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('moves existing actions with their handlers and disabled state, then restores focus and menu order', () => {
    const host = document.createElement('div'); document.body.append(host);
    host.innerHTML = '<div class="primary"></div><details><summary>More</summary><div class="overflow"><button>First</button><button>Second</button></div></details>';
    let width = 400, resized!: () => void;
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect);
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback; } observe() {} disconnect = disconnect; });
    const buttons = [...host.querySelectorAll('button')], clicked = vi.fn(); buttons[0].onclick = clicked;
    buttons[1].disabled = true;
    const dispose = installResponsiveActions({ container: host, toolbar: host.querySelector('.primary')!, actions: buttons, minWidth: 640, fallbackFocus: host.querySelector('summary')! });
    width = 900; resized(); buttons[0].click(); buttons[0].focus();
    expect(clicked).toHaveBeenCalledOnce(); expect(buttons[1].disabled).toBe(true);
    expect(host.querySelector('.primary')!.children).toHaveLength(2);
    width = 400; resized();
    expect(document.activeElement).toBe(host.querySelector('summary'));
    expect([...host.querySelector('.overflow')!.children]).toEqual(buttons);
    dispose(); expect(disconnect).toHaveBeenCalledOnce();
    width = 900; resized(); expect(host.querySelector('.primary')!.children).toHaveLength(0);
});

it('shows saved timestamps and child creation in the menu, refreshing information when opened', async () => {
    let manifest = { id: 'one', title: 'One', createdAt: 1000, updatedAt: 2000 };
    const sessions = { family: async () => ({ members: [manifest] }), get: vi.fn(async () => manifest) };
    const actions = { child: vi.fn(async () => {}), open: vi.fn(), remove: vi.fn(), changed: vi.fn(), showFamily: vi.fn(), report: vi.fn() };
    const abort = new AbortController(), family = new SessionFamilyActions(sessions as never, abort.signal, actions);
    const header = await family.header(manifest as never); document.body.append(header);
    try {
        const time = (name: string) => header.querySelector<HTMLTimeElement>(`[data-session-time="${name}"]`)!.dateTime;
        expect(time('createdAt')).toBe(new Date(1000).toISOString());
        expect(time('updatedAt')).toBe(new Date(2000).toISOString());
        const menu = header.querySelector('details')!; menu.open = true;
        manifest = { ...manifest, updatedAt: 4000 }; menu.dispatchEvent(new Event('toggle'));
        await vi.waitFor(() => expect(time('updatedAt')).toBe(new Date(4000).toISOString()));
        [...menu.querySelectorAll('button')].find(button => button.textContent === '新建子会话')!.click();
        await vi.waitFor(() => expect(actions.child).toHaveBeenCalledWith('one'));
        expect(menu.open).toBe(false); expect(actions.report).not.toHaveBeenCalled();
    } finally { abort.abort(); }
});
