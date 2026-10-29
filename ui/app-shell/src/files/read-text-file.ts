/** Decode a selected file locally, including WebViews without File.arrayBuffer. */
export async function readUtf8File(file: File): Promise<string> {
    const bytes = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(new Error('TEXT_FILE_READ_FAILED')); reader.readAsArrayBuffer(file);
    });
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
}
