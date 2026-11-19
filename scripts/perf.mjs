// Usage: npm run perf -- [sizeMB=300] [shape=mixed|narrow]   (npm script passes --expose-gc)
//   mixed  : 20 columns, a 1-4 KB HTML description (with quotes + newlines) on every 10th row (~700k rows at 300 MB)
//   narrow : 20 columns, short rows (~1.5M rows at 300 MB)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { CsvEngine } = require('../out-test/csv/core/engine.js');

const targetMb = Number(process.argv[2] ?? 300);
const shape = process.argv[3] ?? 'mixed';
const file = path.join(os.tmpdir(), `perf-${targetMb}mb-${shape}.csv`);
const targetBytes = targetMb * 1024 * 1024;

function lorem(words) {
    return 'lorem ipsum dolor sit amet '.repeat(Math.ceil(words / 5)).slice(0, words * 6);
}

function generate() {
    if (fs.existsSync(file) && fs.statSync(file).size >= targetBytes) {
        return;
    }
    console.log(`generating ${file} ...`);
    const fd = fs.openSync(file, 'w');
    const header = ['id', 'sku', 'name', 'price', 'category', 'brand', 'color', 'size', 'stock', 'weight', 'status',
        'created', 'updated', 'vendor', 'tags', 'seo_title', 'seo_description', 'url', 'image', 'description'];
    fs.writeSync(fd, header.join(',') + '\n');
    let written = 0;
    let i = 0;
    let batch = [];
    while (written < targetBytes) {
        const long = shape === 'mixed' && i % 10 === 0;
        const description = long
            ? `<p>${lorem(150 + (i % 450))}</p>\n<ul><li>"feature" ${i}</li></ul>`
            : `Short text ${i}`;
        const row = [
            i, `SKU-${i}`, `Product ${i % 5000}`, (i % 997) / 10, `Category ${i % 40}`, `Brand ${i % 120}`,
            ['red', 'blue', 'green', ''][i % 4], ['S', 'M', 'L', 'XL'][i % 4], i % 300, i % 50,
            i % 7 === 0 ? 'draft' : 'active', '2024-01-01', '2024-06-01', `Vendor ${i % 60}`,
            `tag${i % 10};tag${i % 7}`, `Title ${i}`, `Meta ${i}`, `/p/${i}`, `/img/${i}.jpg`,
            `"${description.replace(/"/g, '""')}"`,
        ];
        batch.push(row.join(',') + '\n');
        if (batch.length >= 2000) {
            const chunk = batch.join('');
            fs.writeSync(fd, chunk);
            written += Buffer.byteLength(chunk);
            batch = [];
        }
        i++;
    }
    fs.writeSync(fd, batch.join(''));
    fs.closeSync(fd);
}

generate();
const sizeMb = fs.statSync(file).size / 1024 / 1024;
const noop = () => undefined;
const token = { cancelled: false };

// Retained memory after a forced GC (RSS also counts garbage that has not been collected yet).
const retainedMb = () => {
    globalThis.gc?.();
    const m = process.memoryUsage();
    return (m.heapUsed + m.external) / 1024 / 1024;
};
const memBefore = retainedMb();
const t0 = performance.now();
const engine = new CsvEngine(file);
const opened = await engine.open();
if (opened.kind !== 'ready') {
    throw new Error(`open failed: ${opened.kind}`);
}
const indexing = engine.index(noop, token);
await engine.getInfo();
await engine.readPage(0, 100);
const firstPage = performance.now() - t0;
await indexing;
const indexTime = performance.now() - t0;

const t1 = performance.now();
const unique = await engine.uniqueValues(4, token); // `category`
const uniqueTime = performance.now() - t1;
const memDelta = retainedMb() - memBefore;
await engine.dispose();

const rows = [
    ['first page', `${firstPage.toFixed(0)} ms`, firstPage < 1000],
    ['full index', `${(indexTime / 1000).toFixed(1)} s`, indexTime <= 10000],
    ['unique (1 column)', `${(uniqueTime / 1000).toFixed(1)} s (${unique?.distinct} distinct)`, uniqueTime <= 10000],
    ['retained memory increase', `${memDelta.toFixed(0)} MB`, memDelta < 100],
];
console.log(`\nfile: ${sizeMb.toFixed(0)} MB, shape: ${shape}`);
for (const [name, value, ok] of rows) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} ${value}`);
}
process.exit(rows.every((r) => r[2]) ? 0 : 1);
