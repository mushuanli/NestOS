/**
 * @file ui-common/utils/clipboard.ts
 * @description Clipboard write with a fallback for non-secure contexts.
 *
 * `navigator.clipboard` is secure-context-only: it is undefined over plain-HTTP
 * LAN origins (e.g. http://192.168.x.x:3000) and in WebKitGTK, so calling
 * `navigator.clipboard.writeText(...)` throws "Cannot read properties of
 * undefined". `document.execCommand('copy')` still works there.
 */

/** Copy text to the clipboard. Returns whether the copy succeeded. */
export async function copyText(text: string): Promise<boolean> {
    const clipboard = globalThis.navigator?.clipboard;
    if (typeof clipboard?.writeText === 'function') {
        try {
            await clipboard.writeText(text);
            return true;
        } catch {
            // Permission denied or insecure context — fall through.
        }
    }
    return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
    if (typeof document === 'undefined' || !document.body) return false;

    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;';
    document.body.appendChild(area);

    let copied = false;
    try {
        area.select();
        area.setSelectionRange(0, text.length);
        copied = document.execCommand('copy');
    } catch {
        copied = false;
    } finally {
        area.remove();
    }
    return copied;
}
