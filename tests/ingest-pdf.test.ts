import { describe, it, expect } from "vitest";
import { convertToMarkdown } from "@/lib/ingest-core";

// Assemble a minimal, single-page PDF whose content stream draws `text` with
// one Tj operator. Object offsets are computed in bytes so the xref table is
// valid and pdf.js parses it without falling back to recovery mode.
function buildMinimalPdf(text: string): Buffer {
  const esc = text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
  const content = `BT /F1 24 Tf 72 700 Td (${esc}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// Regression: pdf.js reaches for the browser-only DOMMatrix global and throws
// "DOMMatrix is not defined" under the Cloudflare Workers (and plain Node)
// runtime that serves /api/upload/preview. convertPdf installs a minimal
// DOMMatrix polyfill so text extraction works without a DOM.
describe("convertPdf — text extraction without a DOM", () => {
  it("converts a PDF to markdown instead of throwing", async () => {
    const pdf = buildMinimalPdf("Hello from a PDF");
    const { body, sourceFormat } = await convertToMarkdown(pdf, ".pdf");
    expect(sourceFormat).toBe("pdf");
    expect(body).toContain("## Page 1");
    expect(body).toContain("Hello from a PDF");
  });
});
