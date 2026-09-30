// pdf.js loads two wasm assets (JPEG2000 via openjpeg, colour management via qcms) on demand for
// certain PDF images. `new URL("pdfjs-dist/wasm/…", import.meta.url)` does not work: Vite leaves the
// bare package specifier untouched, so it resolves against the emitted chunk and returns 404. The
// two files are served as static assets from `public/pdfjs/`, like `public/pdf.worker.min.mjs`, and
// copied from the pinned `pdfjs-dist` (see INSTALL.md). The loads use pdf.js's `WasmFactory` escape
// hatch (`useWorkerFetch: false`) to fetch those served paths.
const PDFJS_WASM_BASE = "/pdfjs";
const PDFJS_WASM_FILENAMES = new Set(["openjpeg.wasm", "qcms_bg.wasm"]);

class BundledWasmFactory {
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    if (!PDFJS_WASM_FILENAMES.has(filename)) {
      throw new Error(`Unexpected pdfjs wasm asset requested: ${filename}`);
    }
    const url = `${PDFJS_WASM_BASE}/${filename}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch pdfjs wasm asset ${filename} at ${url} (status ${response.status})`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

export const PDFJS_DOCUMENT_OPTIONS = {
  WasmFactory: BundledWasmFactory,
  useWorkerFetch: false,
};
