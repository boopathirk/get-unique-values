export type ThemeKind = 'light' | 'dark' | 'high-contrast';

export interface ColumnColor {
    headerBg: string;
    headerFg: string;
    cellTint: string;
    edge: string;
}

/** Golden-angle hue spacing keeps neighbouring columns visually distinct. */
export function columnHue(index: number): number {
    return (index * 137.508) % 360;
}

export function columnColor(index: number, theme: ThemeKind): ColumnColor {
    const h = columnHue(index).toFixed(1);
    switch (theme) {
        case 'light':
            return { headerBg: `hsl(${h} 70% 88%)`, headerFg: `hsl(${h} 55% 20%)`, cellTint: `hsl(${h} 70% 97%)`, edge: `hsl(${h} 65% 55%)` };
        case 'dark':
            return { headerBg: `hsl(${h} 40% 26%)`, headerFg: `hsl(${h} 70% 90%)`, cellTint: `hsl(${h} 35% 17%)`, edge: `hsl(${h} 60% 55%)` };
        default:
            return { headerBg: 'transparent', headerFg: 'inherit', cellTint: 'transparent', edge: `hsl(${h} 100% 60%)` };
    }
}
