// File path helpers shared by the extension host and the worker. No `vscode` import.
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** True when both paths name the same location (resolved; case-insensitive on Windows and macOS). */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
    const ra = path.resolve(a);
    const rb = path.resolve(b);
    return platform === 'win32' || platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** True when both paths are the same file: same location, or (both existing) the same inode, e.g. a hard link. */
export async function isSameFile(a: string, b: string): Promise<boolean> {
    if (samePath(a, b)) {
        return true;
    }
    try {
        const [sa, sb] = await Promise.all([fs.promises.stat(a), fs.promises.stat(b)]);
        return sa.ino !== 0 && sa.dev === sb.dev && sa.ino === sb.ino;
    } catch {
        return false;
    }
}

/** A temporary sibling of `target` that is renamed onto it once complete. */
export function partPath(target: string): string {
    return `${target}.${randomBytes(4).toString('hex')}.part`;
}
