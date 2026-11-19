import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.argv[2] ?? path.join(os.tmpdir(), 'sample-products.csv');
const q = (s) => `"${s.replace(/"/g, '""')}"`;
const rows = ['id,sku,name,price,description,attributes'];
for (let i = 0; i < 5000; i++) {
    rows.push([
        i,
        `SKU-${i}`,
        `Product ${i % 50}`,
        (i % 97) / 10,
        q(`<p>Hello <b>world</b> ${'text '.repeat(i % 60)}</p>\n<ul><li>"quoted"</li></ul>`),
        q(JSON.stringify({ color: ['red', 'blue'][i % 2], size: i % 5 })),
    ].join(','));
}
rows.push('bad,row'); // wrong column count on purpose
fs.writeFileSync(out, rows.join('\n') + '\n');
console.log(`wrote ${rows.length - 1} rows to ${out}`);
