export { PdfReaderAdapter } from './adapters/pdf-adapter';
export { EpubReaderAdapter } from './adapters/epub-adapter';
export { extractBookText } from './extract';
import * as pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs';
(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = pdfWorker;
