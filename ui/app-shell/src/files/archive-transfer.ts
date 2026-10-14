/** Keep the native chooser alive until selection, cancellation or workbench disposal. */
export function chooseArchive(signal: AbortSignal): Promise<File | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise(resolve => {
        const input = document.createElement('input'); input.type = 'file'; input.dataset.workbenchArchive = ''; input.accept = '.json,application/json'; input.hidden = true;
        const finish = (file: File | null) => { input.remove(); signal.removeEventListener('abort', abort); resolve(file); };
        const abort = () => finish(null);
        input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
        input.addEventListener('cancel', abort, { once: true });
        signal.addEventListener('abort', abort, { once: true });
        document.body.append(input); input.click();
    });
}
export function downloadArchive(content: string, name = 'workbench.json'): void {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
