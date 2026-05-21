import { describe, it, expect } from "vitest";
import * as xlsx from "xlsx";
import { convertToMarkdown } from "@/lib/ingest-core";

// A GFM table row must occupy a single physical line. A spreadsheet cell can
// legitimately hold multi-line text (Excel Alt+Enter), and that survives the
// CSV layer as CRLF/CR/LF inside the quoted cell. The ingester encodes those
// breaks as a literal "<br>" so the row stays intact instead of spilling
// across lines and being read as separate cells.
describe("csvToMarkdownTable — in-cell line breaks", () => {
  it("keeps a multi-line CSV cell on one table row", async () => {
    const csv =
      'name,certs\r\n資格,"AWS(2025年9月)\r\nJava(2024年1月)\r\nC言語(2023年12月)"\r\n';
    const { body } = await convertToMarkdown(Buffer.from(csv, "utf8"), ".csv");
    const lines = body.split("\n");
    expect(lines).toHaveLength(3); // header, separator, one body row
    expect(lines[2]).toBe(
      "| 資格 | AWS(2025年9月)<br>Java(2024年1月)<br>C言語(2023年12月) |",
    );
  });

  it("encodes CR, LF and CRLF in-cell breaks identically", async () => {
    for (const nl of ["\n", "\r", "\r\n"]) {
      const csv = `a\n"x${nl}y"\n`;
      const { body } = await convertToMarkdown(Buffer.from(csv, "utf8"), ".csv");
      const lines = body.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe("| x<br>y |");
    }
  });

  it("still escapes pipes inside cells", async () => {
    const { body } = await convertToMarkdown(
      Buffer.from('h\n"a|b"\n', "utf8"),
      ".csv",
    );
    expect(body.split("\n")[2]).toBe("| a\\|b |");
  });

  it("keeps a merged multi-line Excel cell as a single cell", async () => {
    const ws: xlsx.WorkSheet = {
      "!ref": "A1:D2",
      "!merges": [{ s: { r: 1, c: 0 }, e: { r: 1, c: 3 } }],
      A1: { t: "s", v: "資格" },
      A2: { t: "s", v: "AWS(2025年9月)\nJava(2024年1月)\nC言語(2023年12月)" },
    };
    const wb: xlsx.WorkBook = { SheetNames: ["Sheet1"], Sheets: { Sheet1: ws } };
    const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const { body } = await convertToMarkdown(buf, ".xlsx");
    const rowLines = body.split("\n").filter((l) => l.startsWith("|"));
    // The merged cert cell stays on its row; the run never spills onto a
    // line of its own.
    const certRow = rowLines.find((l) => l.includes("AWS(2025年9月)"));
    expect(certRow).toBeDefined();
    expect(certRow).toContain("AWS(2025年9月)<br>Java(2024年1月)<br>C言語(2023年12月)");
    // Merge markers fill the rest of the merged span — the cert text is one
    // logical cell, not three.
    expect(certRow).toContain("←");
    for (const line of rowLines) {
      expect(line.trimEnd().endsWith("|")).toBe(true);
    }
  });
});
