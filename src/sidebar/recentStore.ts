export interface RecentState {
    recent: Array<{ uri: string; at: number }>;
    favorites: string[];
}

export const MAX_RECENT = 20;

export function emptyRecent(): RecentState {
    return { recent: [], favorites: [] };
}

export function sanitizeRecent(raw: unknown): RecentState {
    if (typeof raw !== 'object' || raw === null) {
        return emptyRecent();
    }
    const o = raw as { recent?: unknown; favorites?: unknown };
    const recent = Array.isArray(o.recent)
        ? o.recent.filter((r): r is { uri: string; at: number } =>
            typeof r === 'object' && r !== null && typeof (r as { uri?: unknown }).uri === 'string' && typeof (r as { at?: unknown }).at === 'number')
            .map((r) => ({ uri: r.uri, at: r.at }))
        : [];
    const favorites = Array.isArray(o.favorites) ? o.favorites.filter((f): f is string => typeof f === 'string') : [];
    return { recent: recent.slice(0, MAX_RECENT), favorites: [...new Set(favorites)] };
}

export function touch(s: RecentState, uri: string, at: number): RecentState {
    const rest = s.recent.filter((r) => r.uri !== uri);
    return { ...s, recent: [{ uri, at }, ...rest].slice(0, MAX_RECENT) };
}

export function toggleFavorite(s: RecentState, uri: string): RecentState {
    return s.favorites.includes(uri)
        ? { ...s, favorites: s.favorites.filter((f) => f !== uri) }
        : { ...s, favorites: [...s.favorites, uri] };
}

export function removeRecent(s: RecentState, uri: string): RecentState {
    return { recent: s.recent.filter((r) => r.uri !== uri), favorites: s.favorites.filter((f) => f !== uri) };
}

export function clearRecent(s: RecentState): RecentState {
    return { ...s, recent: [] };
}
