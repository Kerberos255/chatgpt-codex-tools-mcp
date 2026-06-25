const redactionLabel = "[REDACTED]";

const standaloneSecretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\bsk-(?:proj-|admin-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactText(text: string): string {
  let redacted = text
    .replace(
      /((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|cookie|set-cookie)\s*[:=]\s*)(["']?)([^"'\s,;}{]+)(\2)/gi,
      (_match, prefix: string, quote: string, _value: string, closingQuote: string) => `${prefix}${quote}${redactionLabel}${closingQuote}`,
    )
    .replace(
      /("(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|authorization|cookie|set-cookie)"\s*:\s*")([^"]+)(")/gi,
      (_match, prefix: string, _value: string, suffix: string) => `${prefix}${redactionLabel}${suffix}`,
    );
  for (const pattern of standaloneSecretPatterns) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.toLowerCase().startsWith("bearer ")) return `Bearer ${redactionLabel}`;
      return redactionLabel;
    });
  }
  return redacted;
}

export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry)) as T;
  if (!value || typeof value !== "object") return value;

  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/api[_-]?key|token|secret|password|passwd|pwd|authorization|cookie/i.test(key)) {
      copy[key] = typeof entry === "string" && entry.length > 0 ? redactionLabel : redactValue(entry);
    } else {
      copy[key] = redactValue(entry);
    }
  }
  return copy as T;
}
