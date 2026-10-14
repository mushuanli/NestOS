// Minimal ULID generation (Crockford base32, 26-char, time-sortable).
//
// Used as replacement for the BBB_SSSSS_R position-encoding ID scheme.
// A full ULID library is unnecessary for our needs — this ~40 line impl suffices.

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function encodeTime(time: number): string {
    let str = '';
    for (let i = 9; i >= 0; i--) {
        str += ENCODING.charAt(Math.floor(time / 32 ** i) % 32);
    }
    return str;
}

function encodeRandom(length: number): string {
    let str = '';
    for (let i = 0; i < length; i++) {
        str += ENCODING.charAt(Math.floor(Math.random() * 32));
    }
    return str;
}

/**
 * Generate a ULID (Universally Unique Lexicographically Sortable Identifier).
 *
 * Format: 10-char timestamp + 16-char random = 26 chars total.
 * Timestamp portion ensures time-ordering; random portion ensures uniqueness.
 */
export function ulid(): string {
    const now = Date.now();
    return encodeTime(now) + encodeRandom(16);
}

/**
 * Extract timestamp from a ULID string.
 */
export function extractTimestamp(id: string): number {
    let time = 0;
    for (let i = 0; i < 10; i++) {
        time = time * 32 + ENCODING.indexOf(id.charAt(i));
    }
    return time;
}
