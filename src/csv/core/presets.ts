// Saved parse settings ("presets"). Pure helpers: no `vscode` import.

export interface Preset {
    name: string;
    delimiter?: string;
    hasHeader?: boolean;
    encoding?: 'utf-8' | 'latin1';
}

/** One character (tab allowed); a quote or line break can never be a delimiter. */
function isDelimiter(v: unknown): v is string {
    return typeof v === 'string' && v.length === 1 && v !== '"' && v !== '\n' && v !== '\r';
}

/** Keep presets that have a non-empty name; drop any invalid field. */
export function sanitizePresets(raw: unknown): Preset[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: Preset[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const r = item as Record<string, unknown>;
        const name = typeof r.name === 'string' ? r.name.trim() : '';
        if (name === '') {
            continue;
        }
        const preset: Preset = { name };
        if (isDelimiter(r.delimiter)) {
            preset.delimiter = r.delimiter;
        }
        if (typeof r.hasHeader === 'boolean') {
            preset.hasHeader = r.hasHeader;
        }
        if (r.encoding === 'utf-8' || r.encoding === 'latin1') {
            preset.encoding = r.encoding;
        }
        out.push(preset);
    }
    return out;
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Replace the preset with the same name (case-insensitive), or append it. */
export function upsertPreset(list: Preset[], preset: Preset): Preset[] {
    const i = list.findIndex((p) => sameName(p.name, preset.name));
    if (i < 0) {
        return [...list, preset];
    }
    const next = list.slice();
    next[i] = preset;
    return next;
}

export function removePreset(list: Preset[], name: string): Preset[] {
    return list.filter((p) => !sameName(p.name, name));
}

/** e.g. "; · header · utf-8", or "auto-detect" when nothing is set. */
export function describePreset(p: Preset): string {
    const parts: string[] = [];
    if (p.delimiter !== undefined) {
        parts.push(p.delimiter === '\t' ? 'Tab' : p.delimiter);
    }
    if (p.hasHeader !== undefined) {
        parts.push(p.hasHeader ? 'header' : 'no header');
    }
    if (p.encoding !== undefined) {
        parts.push(p.encoding);
    }
    return parts.length > 0 ? parts.join(' · ') : 'auto-detect';
}

/** The values of the presets setting per scope, as `WorkspaceConfiguration.inspect` returns them. */
export interface PresetScopes {
    defaultValue?: unknown;
    globalValue?: unknown;
    workspaceValue?: unknown;
}

/**
 * Where saving or deleting a preset must write: the workspace settings when they define presets (they
 * override the user settings), otherwise the user settings. `list` is that scope's own presets, so a
 * change never copies presets from the other scope into it.
 */
export function presetWriteTarget(scopes: PresetScopes | undefined): { scope: 'workspace' | 'global'; list: Preset[] } {
    if (scopes?.workspaceValue !== undefined) {
        return { scope: 'workspace', list: sanitizePresets(scopes.workspaceValue) };
    }
    return { scope: 'global', list: sanitizePresets(scopes?.globalValue) };
}
