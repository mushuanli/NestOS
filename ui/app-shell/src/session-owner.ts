/**
 * @file app-shell/session-owner.ts
 * @desc 当前窗口/标签页的 Session 写租约身份。
 *
 * 页面重载会销毁旧页面的 JS，但旧页面持有的 Session 租约在 TTL 内仍然有效；新页面若换一个
 * 随机身份就会把所有 Session 判为「他人所有」而只读，直到租约过期。这里把身份放进
 * `sessionStorage`：同一窗口重载后复用同一个 token，可以立刻接管自己的租约；不同窗口/标签页
 * 各自独立，单写者语义不变。
 *
 * 存储不可用（禁用存储、隐私模式、非 DOM 宿主）时退回「每次一个随机 token」，即改动前的行为。
 */
const OWNER_TOKEN_KEY = 'mindos.session-owner-token';

function randomToken(): string {
    return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

/** 稳定的单窗口租约 token；同一窗口内多次调用返回同一个值。 */
export function windowSessionLeaseToken(): string {
    try {
        const storage = globalThis.sessionStorage;
        const existing = storage?.getItem(OWNER_TOKEN_KEY);
        if (existing) return existing;
        const created = randomToken();
        storage?.setItem(OWNER_TOKEN_KEY, created);
        return created;
    } catch {
        return randomToken();
    }
}
