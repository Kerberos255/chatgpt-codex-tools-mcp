export type GlobMatcher = (path: string) => boolean;

export interface GlobMatcherOptions {
  matchBasename?: boolean;
}

export function createGlobMatcher(patternText: string, options: GlobMatcherOptions = {}): GlobMatcher {
  const patterns = splitGlobPatterns(patternText);
  const regexes = patterns.map((pattern) => new RegExp(`^${globToRegexSource(pattern)}$`, "i"));

  return (path: string) => {
    const normalized = normalizeGlobPattern(path).replace(/\/$/, "");
    const basename = normalized.split("/").pop() ?? normalized;
    return regexes.some((regex) => regex.test(normalized) || Boolean(options.matchBasename && regex.test(basename)));
  };
}

export function splitGlobPatterns(patternText: string): string[] {
  return splitTopLevel(patternText, ",")
    .map((entry) => normalizeGlobPattern(entry))
    .filter(Boolean);
}

function normalizeGlobPattern(value: string): string {
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function globToRegexSource(pattern: string): string {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        while (pattern[i + 1] === "*") i += 1;
        if (pattern[i + 1] === "/") {
          source += "(?:.*/)?";
          i += 1;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "{") {
      const close = findClosingBrace(pattern, i);
      if (close !== -1) {
        const inner = pattern.slice(i + 1, close);
        const alternatives = splitTopLevel(inner, ",").map((entry) => globToRegexSource(entry));
        source += `(?:${alternatives.join("|")})`;
        i = close;
        continue;
      }
    }

    source += escapeRegex(char);
  }
  return source;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === "{") depth += 1;
    if (char === "}" && depth > 0) depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function findClosingBrace(value: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < value.length; i += 1) {
    if (value[i] === "{") depth += 1;
    if (value[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeRegex(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}
