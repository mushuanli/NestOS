/** Read browser bytes without exposing file names or native reader errors. */
export async function fileBytes(file: File): Promise<ArrayBuffer> {
    try {
        if (file.arrayBuffer) return await file.arrayBuffer();
        return await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(reader.result) : reject(unreadable());
            reader.onerror = () => reject(unreadable()); reader.readAsArrayBuffer(file);
        });
    } catch {throw unreadable();}
}
function unreadable(): Error {
    return Object.assign(new Error('Cannot read the selected file'), {code: 'INPUT_ASSET_CLIENT_READ_FAILED'});
}
