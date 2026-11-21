/** Ripgrep's --null separates every path from line and context data unambiguously. */
export function parseRipgrepOutputPath(line: string): string | null {
  const separator = line.indexOf("\0");
  return separator > 0 ? normalizeToolPath(line.slice(0, separator)) : null;
}

export function normalizeRipgrepOutputLine(line: string): string {
  const separator = line.indexOf("\0");
  if (separator < 0) return line;
  return `${normalizeToolPath(line.slice(0, separator))}:${line.slice(separator + 1)}`;
}

function normalizeToolPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}
