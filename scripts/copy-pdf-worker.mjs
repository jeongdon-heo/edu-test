import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfjsPkg = require.resolve("pdfjs-dist/package.json");
const source = resolve(dirname(pdfjsPkg), "build/pdf.worker.min.mjs");
const dest = resolve(process.cwd(), "public/pdf.worker.min.mjs");

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(source, dest);
console.log(`[pdf-worker] copied ${source} -> ${dest}`);
