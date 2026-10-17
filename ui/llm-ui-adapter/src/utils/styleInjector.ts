// @file: llm-ui/utils/styleInjector.ts

/** Inject a scoped <style> element into <head> (idempotent — skips if id exists). */
export function injectStyle(id: string, css: string): void {
    if (document.getElementById(id)) return;
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
}
