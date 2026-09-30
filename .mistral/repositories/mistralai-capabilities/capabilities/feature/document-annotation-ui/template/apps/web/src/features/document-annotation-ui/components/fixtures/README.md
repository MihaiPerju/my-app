# Captured OCR citation fixture

Real OCR response captured on 2026-09-22 using `mistralai==2.9.4` and `mistral-ocr-4-0`
(requested and returned). The input was a synthetic two-page PDF with no customer data.

Request: `include_blocks=True`, `include_image_base64=True`; table/header/footer extraction
options omitted. Only `images[].image_base64` was removed from the response.

`regions.test.ts` checks all 18 blocks, covering lists, a table, an image, and repeated text.
This offline fixture protects the mapping code; it cannot guarantee equality or detect future
server changes without a new capture.

Input SHA-256: `370427cce86671386592f717cc68c996b0bf558cb3bc97601e2c6d5e90e3ecc9`.
