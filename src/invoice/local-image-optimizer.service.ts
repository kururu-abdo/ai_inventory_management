import sharp from "sharp";

export type OptimizedImageFormat = "jpeg" | "webp";

export interface ImageOptimizationOptions {
  format?: OptimizedImageFormat;
  quality?: number;
  maxDimension?: number;
}

export interface OptimizedInvoiceImage {
  /** Send this directly in the API request. Never save it to a Supabase bucket. */
  dataUrl: string;
  mimeType: "image/jpeg" | "image/webp";
  width: number;
  height: number;
  byteLength: number;
}

const DEFAULTS: Required<ImageOptimizationOptions> = {
  format: "jpeg",
  quality: 76,
  maxDimension: 1200,
};

/** Performs all transformations locally in Electron/Node memory via libvips. */
export class LocalInvoiceImageOptimizer {
  public async optimize(
    source: string | Buffer,
    options: ImageOptimizationOptions = {},
  ): Promise<OptimizedInvoiceImage> {
    const settings = { ...DEFAULTS, ...options };
    if (!Number.isInteger(settings.quality) || settings.quality < 70 || settings.quality > 80) {
      throw new Error("Image quality must be an integer between 70 and 80");
    }
    if (!Number.isInteger(settings.maxDimension) || settings.maxDimension < 1 || settings.maxDimension > 1200) {
      throw new Error("maxDimension must be an integer no greater than 1200");
    }

    const pipeline = sharp(source, { failOn: "warning", limitInputPixels: 40_000_000 })
      .rotate() // honor EXIF orientation before calculating dimensions
      .grayscale()
      .resize({
        width: settings.maxDimension,
        height: settings.maxDimension,
        fit: "inside",
        withoutEnlargement: true,
      });

    const output = settings.format === "jpeg"
      ? await pipeline.jpeg({ quality: settings.quality, mozjpeg: true }).toBuffer({ resolveWithObject: true })
      : await pipeline.webp({ quality: settings.quality, effort: 4 }).toBuffer({ resolveWithObject: true });

    const mimeType: OptimizedInvoiceImage["mimeType"] = settings.format === "jpeg"
      ? "image/jpeg"
      : "image/webp";
    const dataUrl = `data:${mimeType};base64,${output.data.toString("base64")}`;
    const result = {
      dataUrl,
      mimeType,
      width: output.info.width,
      height: output.info.height,
      byteLength: output.data.length,
    };
    // The base64 data URL is now the only optimized representation retained.
    output.data.fill(0);
    return result;
  }
}
