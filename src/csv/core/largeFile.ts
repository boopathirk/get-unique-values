const MB = 1024 * 1024;
const EXTENSIONS = ['.csv', '.tsv', '.psv'];

export function shouldPrompt(sizeBytes: number, thresholdMB: number, fileName: string): boolean {
    if (thresholdMB <= 0) {
        return false;
    }
    const lower = fileName.toLowerCase();
    return EXTENSIONS.some((e) => lower.endsWith(e)) && sizeBytes > thresholdMB * MB;
}
