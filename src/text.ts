/** Cut bytes only at a complete UTF-8 code point boundary. */
export function truncateUtf8(buffer: Buffer, maxBytes: number): string {
  const end = Math.min(buffer.byteLength, Math.max(0, maxBytes));
  if (end === 0) return "";
  let start = end - 1;
  while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--;
  if (start < 0) return "";
  const lead = buffer[start];
  const expected = lead >= 0xf0 && lead <= 0xf4 ? 4
    : lead >= 0xe0 && lead <= 0xef ? 3
    : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
  return buffer.subarray(0, start + expected > end ? start : end).toString("utf8");
}

export function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n[output truncated]\n";
  const markerBytes = Buffer.byteLength(marker);
  if (maxBytes < markerBytes) return truncateUtf8(Buffer.from(text), maxBytes);
  return truncateUtf8(Buffer.from(text), maxBytes - markerBytes) + marker;
}
