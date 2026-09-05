/** Coordinates are in pixels of the locally optimized invoice image. */
export interface OcrBoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OcrTextBlock {
  text: string;
  boundingBox: OcrBoundingBox;
  /** 0..1 where supplied by the platform; ML Kit may omit it. */
  confidence?: number;
}

export interface LocalOcrResult {
  blocks: OcrTextBlock[];
  /** Complete local transcription. This must never be persisted without consent. */
  fullText: string;
}

/**
 * Platform boundary: Flutter implements this with Google ML Kit. The Node core
 * never attempts to upload the image in order to perform OCR.
 */
export interface LocalOcrEngine<ImageSource = string | Buffer> {
  recognize(optimizedLocalImage: ImageSource): Promise<LocalOcrResult>;
}

export function readingOrderText(blocks: readonly OcrTextBlock[]): string {
  return [...blocks]
    .sort((a, b) => {
      const verticalTolerance = Math.max(a.boundingBox.height, b.boundingBox.height) * 0.45;
      if (Math.abs(a.boundingBox.top - b.boundingBox.top) <= verticalTolerance) {
        return a.boundingBox.left - b.boundingBox.left;
      }
      return a.boundingBox.top - b.boundingBox.top;
    })
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}
