/**
 * Generate a default file title using current date and time.
 * Format: "YYYY-MM-DD HH-mm-ss" — local time, filesystem-safe (no colons).
 *
 * @example "2026-05-01 14-30-05"
 */
export function formatDefaultFileTitle(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

/**
 * Preserve the original extension unless the user supplies an explicit suffix.
 *
 * @param newTitle       The user-supplied new title (may or may not include the extension).
 * @param originalFilename  The current filename including extension (e.g. "notes.md").
 * @returns `{ filename }` — the new filename with an explicit or preserved extension.
 *          `{ title }` — the bare title without any extension (for use in metadata/manifests).
 *
 * @example
 * buildRenamedFilename('new-notes', 'old-notes.md')
 * // → { filename: 'new-notes.md', title: 'new-notes' }
 *
 * buildRenamedFilename('new-notes.md', 'old-notes.md')
 * // → { filename: 'new-notes.md', title: 'new-notes' }  (extension stripped from title)
 */

export function buildRenamedFilename(
    newTitle: string,
    originalFilename: string,
): { filename: string; title: string } {
    const dotIdx = originalFilename.lastIndexOf('.');
    const ext = dotIdx > 0 ? originalFilename.slice(dotIdx) : '';
    const requestedDot = newTitle.lastIndexOf('.');
    const explicit = requestedDot > 0 && requestedDot < newTitle.length - 1;
    return explicit
        ? { filename: newTitle, title: newTitle.slice(0, requestedDot) }
        : { filename: newTitle + ext, title: newTitle };
}
