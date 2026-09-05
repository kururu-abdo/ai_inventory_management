import type { LocalOcrResult } from "./local-ocr.types.js";

/** A deterministic local heuristic; it does not send coordinates anywhere. */
export class InvoiceLayoutComplexityScorer {
  public score(ocr: LocalOcrResult): number {
    const blocks = ocr.blocks.filter((block) => block.text.trim());
    if (blocks.length === 0) return 1;
    const imageWidth = Math.max(...blocks.map((block) => block.boundingBox.left + block.boundingBox.width), 1);
    const columns = new Set(blocks.map((block) => Math.min(5, Math.floor((block.boundingBox.left / imageWidth) * 6))));
    const overlaps = countOverlaps(blocks.map((block) => block.boundingBox));
    const density = Math.min(1, blocks.length / 60);
    const columnComplexity = Math.min(1, Math.max(0, columns.size - 2) / 3);
    const overlapComplexity = Math.min(1, overlaps / Math.max(1, blocks.length / 3));
    return Number((density * 0.35 + columnComplexity * 0.35 + overlapComplexity * 0.3).toFixed(2));
  }
}

function countOverlaps(boxes: Array<{ left: number; top: number; width: number; height: number }>): number {
  let overlaps = 0;
  for (let index = 0; index < boxes.length; index += 1) {
    const a = boxes[index]!;
    for (let otherIndex = index + 1; otherIndex < boxes.length; otherIndex += 1) {
      const b = boxes[otherIndex]!;
      const horizontal = Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
      const vertical = Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
      if (horizontal * vertical > 0) overlaps += 1;
    }
  }
  return overlaps;
}
