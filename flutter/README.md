# Flutter ML Kit adapter

Copy `lib/invoice_ocr/mlkit_local_invoice_ocr.dart` into the Flutter client and add these dependencies to its `pubspec.yaml`:

```yaml
dependencies:
  google_mlkit_text_recognition: ^0.17.1
  image: ^4.5.4
  path_provider: ^2.1.5
```

`MlKitLocalInvoiceOcr.recognize` locally converts the invoice to a 1200-px, grayscale, quality-76 JPEG, runs ML Kit over that file, returns text-block coordinates, then deletes the temporary JPEG. It performs no upload. Its `LocalOcrResultDto.toJson()` is the DTO expected by the TypeScript `LocalOcrEngine` interface.

For Android, explicitly bundle the Latin model in `android/app/build.gradle` to guarantee first-use offline operation (rather than using the Play Services model that may download on first use):

```gradle
dependencies {
  implementation 'com.google.mlkit:text-recognition:16.0.1'
}
```

The included ML Kit recognizer is Latin-script. If Arabic OCR is a requirement, evaluate a local Arabic-capable OCR engine separately; do not claim the Latin recognizer covers Arabic invoices.
