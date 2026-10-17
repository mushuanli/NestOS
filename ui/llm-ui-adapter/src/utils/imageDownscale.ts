// @file: llm-ui/utils/imageDownscale.ts
//
// 图片降采样工具 — 在发往 OCR(视觉)连接之前缩小图片以节省 token。
//
// 策略:
//   - 长边超过 maxEdge 时按比例缩放到 maxEdge,保留宽高比
//   - 长边已在范围内则原样返回(不放大,避免损失识别率)
//   - 统一转码为 JPEG(默认),压缩体积;有 alpha 需求可指定 webp
//   - 任意环节失败均回退原 blob —— 降采样是优化而非必需,不应阻断 OCR
//
// 纯浏览器 API(createImageBitmap + canvas),无外部依赖。

export interface DownscaleOptions {
    /** 缩放后图片的最大长边像素,默认 2000 */
    maxEdge?: number;
    /** 输出编码格式,默认 image/jpeg */
    mime?: 'image/jpeg' | 'image/webp';
    /** 有损编码质量 [0,1],默认 0.85 */
    quality?: number;
}

const DEFAULTS: Required<DownscaleOptions> = {
    maxEdge: 2000,
    mime: 'image/jpeg',
    quality: 0.85,
};

/**
 * 将图片 Blob 降采样用于 OCR 调用。失败时回退原 blob。
 */
export async function downscaleImageForOcr(
    blob: Blob,
    options?: DownscaleOptions,
): Promise<Blob> {
    const { maxEdge, mime, quality } = { ...DEFAULTS, ...options };

    // 非位图(svg 等)无法可靠重绘 —— 原样返回
    if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') {
        return blob;
    }

    try {
        const bitmap = await createImageBitmap(blob);
        const { width, height } = bitmap;
        const longEdge = Math.max(width, height);

        // 已在范围内:不放大,直接返回原图保识别率
        if (longEdge <= maxEdge) {
            bitmap.close?.();
            return blob;
        }

        const scale = maxEdge / longEdge;
        const targetW = Math.round(width * scale);
        const targetH = Math.round(height * scale);

        const out = await drawToBlob(bitmap, targetW, targetH, mime, quality);
        bitmap.close?.();

        // 编码失败或反而更大,回退原图
        return out && out.size < blob.size ? out : blob;
    } catch {
        return blob;
    }
}

/**
 * 将位图重绘到目标尺寸并编码为 Blob。
 * 优先使用 OffscreenCanvas(worker 安全),回退到普通 canvas。
 */
async function drawToBlob(
    bitmap: ImageBitmap,
    w: number,
    h: number,
    mime: string,
    quality: number,
): Promise<Blob | null> {
    // OffscreenCanvas 路径(现代浏览器)
    if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(bitmap, 0, 0, w, h);
        return canvas.convertToBlob({ type: mime, quality });
    }

    // 回退:普通 <canvas> + toBlob
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b), mime, quality),
    );
}
