import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export const MAX_GENERATION_SOURCES = 48;
export const MAX_GENERATION_CHARS_PER_SOURCE = 16_000;
export const MAX_GENERATION_TOTAL_CHARS = 64_000;

function cleanText(value, limit = MAX_GENERATION_CHARS_PER_SOURCE) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, limit);
}

function extensionFor(record) {
  const explicit = String(record?.extension || "").toLocaleLowerCase("en-US");
  if (explicit) return explicit;
  return String(record?.fileName || "").split(".").pop()?.toLocaleLowerCase("en-US") || "";
}

async function extractPdf(blob, limit) {
  const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const document = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const chunks = [];
  let length = 0;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages && length < limit; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = cleanText(content.items.map((item) => item?.str || "").join(" "), limit - length);
      if (!pageText) continue;
      const chunk = `[Page ${pageNumber}]\n${pageText}`;
      chunks.push(chunk);
      length += chunk.length + 2;
    }
  } finally {
    await document.destroy();
  }
  return cleanText(chunks.join("\n\n"), limit);
}

async function extractDocx(blob, limit) {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() });
  return cleanText(result.value, limit);
}

export async function extractStudySourceText(record, blob, limit = MAX_GENERATION_CHARS_PER_SOURCE) {
  if (!(blob instanceof Blob)) throw new TypeError("A readable source file is required.");
  const extension = extensionFor(record);
  if (extension === "txt") return cleanText(await blob.text(), limit);
  if (extension === "pdf") return extractPdf(blob, limit);
  if (extension === "docx") return extractDocx(blob, limit);
  if (extension === "doc") {
    throw new Error("Legacy .doc files cannot be parsed safely in the browser. Save the file as DOCX, PDF, or TXT first.");
  }
  throw new Error("This source type is not supported for generation.");
}

function safeSourceId(value, index) {
  const candidate = String(value || "").trim();
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate)
    && !["__proto__", "constructor", "prototype"].includes(candidate)
    ? candidate
    : `source-${index + 1}`;
}

export async function extractStudySourcePackets(records, readSourceFile) {
  if (typeof readSourceFile !== "function") {
    throw new TypeError("A Study Deck source reader is required.");
  }
  const selected = (Array.isArray(records) ? records : []).slice(0, MAX_GENERATION_SOURCES);
  const sources = [];
  const skipped = [];
  let remaining = MAX_GENERATION_TOTAL_CHARS;

  for (const [index, record] of selected.entries()) {
    if (remaining < 40) break;
    const sourcesLeft = selected.length - index;
    const fairSourceBudget = Math.max(40, Math.floor(remaining / sourcesLeft));
    const fileName = String(record?.fileName || `Source ${index + 1}`).split(/[\\/]/u).at(-1).slice(0, 160);
    try {
      const blob = await readSourceFile(record);
      const text = await extractStudySourceText(record, blob, Math.min(MAX_GENERATION_CHARS_PER_SOURCE, fairSourceBudget));
      if (text.length < 40) throw new Error("No usable text was found in this file.");
      sources.push({
        fileName,
        id: safeSourceId(record?.id, index),
        text,
      });
      remaining -= text.length;
    } catch (error) {
      skipped.push({
        fileName,
        reason: error instanceof Error ? error.message : "The source could not be read.",
      });
    }
  }

  return { skipped, sources };
}
