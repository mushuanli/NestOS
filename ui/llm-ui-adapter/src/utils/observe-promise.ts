/** Cancel one observer without cancelling a shared immutable operation. */
export function observePromise<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const finish = () => signal.removeEventListener('abort', abort);
        const abort = () => {finish(); reject(signal.reason);};
        signal.addEventListener('abort', abort, {once: true});
        void promise.then(value => {finish(); resolve(value);}, error => {finish(); reject(error);});
    });
}
