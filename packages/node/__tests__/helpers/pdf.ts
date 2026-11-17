import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Builds a valid PDF with one page per marker. Each page's content stream draws
 * its marker text uncompressed, so tests can find which pages an output holds
 * by searching its bytes. Hand-built so tests need neither qpdf nor committed
 * binary fixtures.
 */
export function pdfWithMarkers(markers: readonly string[]): Buffer {
  const pageObjectNumber = (index: number): number => 4 + index * 2;
  const kids = markers.map((_, index) => `${pageObjectNumber(index)} 0 R`);

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${markers.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  markers.forEach((marker, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageObjectNumber(index) + 1} 0 R >>`,
    );
    const content = `BT /F1 12 Tf 20 100 Td (${marker}) Tj ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  return Buffer.from(serialize(objects), "latin1");
}

/**
 * Like {@link pdfWithMarkers}, but the pages carry no /Resources or /MediaBox of
 * their own: both are inherited from the /Pages node. A page copied out of such
 * a document is only complete if the copy brings the inherited values along.
 */
export function pdfWithInheritedPageAttributes(markers: readonly string[]): Buffer {
  const pageObjectNumber = (index: number): number => 4 + index * 2;
  const kids = markers.map((_, index) => `${pageObjectNumber(index)} 0 R`);

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${markers.length} /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  markers.forEach((marker, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /Contents ${pageObjectNumber(index) + 1} 0 R >>`);
    const content = `BT /F1 12 Tf 20 100 Td (${marker}) Tj ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  return Buffer.from(serialize(objects), "latin1");
}

export function serialize(objects: readonly string[]): string {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return body;
}

/**
 * Three pages in which page 1 has a link annotation whose destination is page
 * 3. Extracting page 1 must not drag page 3 (or its content) along.
 */
export function pdfWithLinkToLaterPage(): Buffer {
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R /Annots [10 0 R] >>",
    "<< /Length 38 >>\nstream\nBT /F1 12 Tf 20 100 Td (L1) Tj ET\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>",
    "<< /Length 38 >>\nstream\nBT /F1 12 Tf 20 100 Td (L2) Tj ET\nendstream",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R >> >> /Contents 9 0 R >>",
    "<< /Length 38 >>\nstream\nBT /F1 12 Tf 20 100 Td (L3) Tj ET\nendstream",
    "<< /Type /Annot /Subtype /Link /Rect [10 10 100 50] /Border [0 0 0] /Dest [8 0 R /Fit] >>",
  ];
  return Buffer.from(serialize(objects), "latin1");
}

export function makeTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), "qpdf-node-test-"));
}

export function writePdf(directory: string, fileName: string, markers: readonly string[]): string {
  const path = join(directory, fileName);
  writeFileSync(path, pdfWithMarkers(markers));
  return path;
}

/** Returns the candidate markers present in the PDF at `path`, in file order. */
export function markersIn(path: string, candidates: readonly string[]): string[] {
  return markersInBytes(readFileSync(path), candidates);
}

/** Like {@link markersIn}, for PDF bytes. Repeated markers are reported once. */
export function markersInBytes(bytes: Uint8Array, candidates: readonly string[]): string[] {
  const text = Buffer.from(bytes).toString("latin1");
  return candidates
    .map((marker) => ({ marker, position: text.indexOf(`(${marker})`) }))
    .filter((found) => found.position >= 0)
    .sort((left, right) => left.position - right.position)
    .map((found) => found.marker);
}

/** Every `(marker)` occurrence in the PDF bytes, in file order, duplicates included. */
export function markerOccurrences(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString("latin1");
  return [...text.matchAll(/\(([A-Z]+\d+)\) Tj/g)].map((match) => match[1] as string);
}
