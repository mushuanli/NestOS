// @file: llm-ui/utils/timeUtils.ts

/** Format timestamp for display: same-day shows time only, older includes date. */
export function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
}

/** Relative time-ago string: "just now", "5m ago", "2h ago", "7d ago", or locale date. */
export function formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    return new Date(timestamp).toLocaleDateString();
}
