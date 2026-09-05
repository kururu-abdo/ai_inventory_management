// Add to the host Flutter app's pubspec.yaml:
//   google_mlkit_text_recognition: ^0.17.1
//   image: ^4.5.4
//   path_provider: ^2.1.5
// This module does not make any network request.

import 'dart:io';
import 'dart:typed_data';

import 'package:google_mlkit_text_recognition/google_mlkit_text_recognition.dart';
import 'package:image/image.dart' as image;
import 'package:path_provider/path_provider.dart';

class OcrBoundingBoxDto {
  const OcrBoundingBoxDto(this.left, this.top, this.width, this.height);
  final double left;
  final double top;
  final double width;
  final double height;

  Map<String, num> toJson() => {
        'left': left,
        'top': top,
        'width': width,
        'height': height,
      };
}

class OcrTextBlockDto {
  const OcrTextBlockDto({required this.text, required this.boundingBox});
  final String text;
  final OcrBoundingBoxDto boundingBox;

  Map<String, Object> toJson() => {
        'text': text,
        'boundingBox': boundingBox.toJson(),
      };
}

class LocalOcrResultDto {
  const LocalOcrResultDto({required this.fullText, required this.blocks});
  final String fullText;
  final List<OcrTextBlockDto> blocks;

  /// This JSON shape maps directly to src/invoice/local-ocr.types.ts.
  Map<String, Object> toJson() => {
        'fullText': fullText,
        'blocks': blocks.map((block) => block.toJson()).toList(growable: false),
      };
}

/// Creates an optimized *local* JPEG, then runs native Google ML Kit OCR over it.
/// The transient JPEG is deleted immediately after ML Kit finishes.
class MlKitLocalInvoiceOcr {
  MlKitLocalInvoiceOcr({this.quality = 76, this.maxDimension = 1200})
      : assert(quality >= 70 && quality <= 80),
        assert(maxDimension > 0 && maxDimension <= 1200);

  final int quality;
  final int maxDimension;

  Future<LocalOcrResultDto> recognize(File originalInvoice) async {
    final optimized = await _createOptimizedJpeg(originalInvoice);
    final recognizer = TextRecognizer(script: TextRecognitionScript.latin);
    try {
      // ML Kit executes on-device. InputImage is a local file, not a URL.
      final recognized = await recognizer.processImage(InputImage.fromFile(optimized));
      return LocalOcrResultDto(
        fullText: recognized.text,
        blocks: recognized.blocks
            .where((block) => block.text.trim().isNotEmpty)
            .map((block) => OcrTextBlockDto(
                  text: block.text,
                  boundingBox: OcrBoundingBoxDto(
                    block.boundingBox.left,
                    block.boundingBox.top,
                    block.boundingBox.width,
                    block.boundingBox.height,
                  ),
                ))
            .toList(growable: false),
      );
    } finally {
      await recognizer.close();
      // This is a local cache artifact only; no raw/optimized image is uploaded.
      if (await optimized.exists()) await optimized.delete();
    }
  }

  Future<File> _createOptimizedJpeg(File original) async {
    final source = await original.readAsBytes();
    final decoded = image.decodeImage(source);
    if (decoded == null) throw const FormatException('Unsupported invoice image');

    final oriented = image.bakeOrientation(decoded);
    final scale = maxDimension / _largest(oriented.width, oriented.height);
    final resized = scale < 1
        ? image.copyResize(
            oriented,
            width: (oriented.width * scale).round(),
            height: (oriented.height * scale).round(),
            interpolation: image.Interpolation.average,
          )
        : oriented;
    final grayscale = image.grayscale(resized);
    final encoded = Uint8List.fromList(image.encodeJpg(grayscale, quality: quality));

    final cache = await getTemporaryDirectory();
    final output = File('${cache.path}${Platform.pathSeparator}ocr-${DateTime.now().microsecondsSinceEpoch}.jpg');
    await output.writeAsBytes(encoded, flush: true);
    // Drop references to buffers as soon as the local temp file is written.
    encoded.fillRange(0, encoded.length, 0);
    source.fillRange(0, source.length, 0);
    return output;
  }

  int _largest(int first, int second) => first > second ? first : second;
}
