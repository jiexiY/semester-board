import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(projectDir, "dist");
const outputPath = resolve(projectDir, "..", "..", "outputs", "Semester Syllabus Dashboard.html");

let html = await readFile(resolve(distDir, "index.html"), "utf8");

const stylesheetMatch = html.match(/<link rel="stylesheet"[^>]*href="([^"]+\.css)"[^>]*>/);
if (stylesheetMatch) {
  const cssPath = resolve(distDir, stylesheetMatch[1].replace(/^\.\//, ""));
  const css = (await readFile(cssPath, "utf8")).replace(/<\/style/gi, "<\\/style");
  html = html.replace(stylesheetMatch[0], () => `<style>${css}</style>`);
}

const scriptMatch = html.match(/<script type="module"[^>]*src="([^"]+\.js)"><\/script>/);
if (!scriptMatch) throw new Error("Built JavaScript asset was not found in index.html");
const scriptPath = resolve(distDir, scriptMatch[1].replace(/^\.\//, ""));
const js = (await readFile(scriptPath, "utf8")).replace(/<\/script/gi, "<\\/script");
// Use a replacer function so `$&`, `$\`` and `$'` sequences in the compiled
// bundle are inserted literally instead of being expanded by String.replace.
html = html.replace(scriptMatch[0], () => `<script type="module">${js}</script>`);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, "utf8");
console.log(`Wrote offline dashboard: ${outputPath}`);
