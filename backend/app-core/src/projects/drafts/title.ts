import {formatDefaultFileTitle} from '@itookit/common';
import {FSError} from '@itookit/vfs-core';

export function preparedTitle(value?: string): string {
    if (value === undefined || value === '') return formatDefaultFileTitle();
    if (typeof value !== 'string' || value.trim().length > 200 || /[\r\n\0]/.test(value))
        throw new FSError('EINVAL', 'Draft title must be a single line of at most 200 characters');
    return value.trim() || formatDefaultFileTitle();
}
