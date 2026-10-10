const changes = new EventTarget();
let available = true;

export function setStorageAvailable(value: boolean): void {
    if (available === value) return;
    available = value; changes.dispatchEvent(new Event('change'));
}
export function onStorageConnectionChange(listener: (available: boolean) => void): () => void {
    const notify = () => listener(available);
    changes.addEventListener('change', notify); notify();
    return () => changes.removeEventListener('change', notify);
}
