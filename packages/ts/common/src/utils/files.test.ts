import { describe, expect, it } from "vitest";

import { base64ToFile } from "./files.js";

describe("base64ToFile", () => {
  it("creates a File with the correct name and MIME type", () => {
    const base64 = btoa("hello");
    const file = base64ToFile(base64, "text/plain", "test.txt");
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("test.txt");
    expect(file.type).toBe("text/plain");
  });

  it("decodes base64 content correctly", async () => {
    const original = "Hello World";
    const base64 = btoa(original);
    const file = base64ToFile(base64, "text/plain", "hello.txt");
    const text = await file.text();
    expect(text).toBe(original);
  });

  it("preserves binary data for images", async () => {
    // 1x1 red PNG pixel
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";
    const file = base64ToFile(pngBase64, "image/png", "pixel.png");
    expect(file.name).toBe("pixel.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBeGreaterThan(0);

    const bytes = new Uint8Array(await file.arrayBuffer());
    // PNG magic bytes
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4e); // N
    expect(bytes[3]).toBe(0x47); // G
  });

  it("handles empty base64 string", () => {
    const file = base64ToFile("", "application/octet-stream", "empty.bin");
    expect(file.size).toBe(0);
    expect(file.name).toBe("empty.bin");
  });

  it("throws a readable error for invalid base64 input", () => {
    expect(() =>
      base64ToFile("not valid base64!!!", "text/plain", "bad.txt"),
    ).toThrow("base64ToFile: invalid base64 string");
  });

  it("throws for input with illegal base64 characters", () => {
    expect(() => base64ToFile("####", "text/plain", "bad.txt")).toThrow(
      "base64ToFile: invalid base64 string",
    );
  });
});
