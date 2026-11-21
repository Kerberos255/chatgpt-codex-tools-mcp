import { compile } from "html-to-text";

// One compiled selector set for all HTML fetches; parsing is bounded by webMaxBytes.
const toText = compile({
  wordwrap: false,
  selectors: [
    { selector: "script", format: "skip" },
    { selector: "style", format: "skip" },
    { selector: "noscript", format: "skip" },
    { selector: "svg", format: "skip" },
    { selector: "nav", format: "skip" },
    { selector: "footer", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
  ],
});

export type FetchFormat = "raw" | "text";

export function formatFetchedBody(source: string, contentType: string, format: FetchFormat): string {
  if (format !== "text" || !/^\s*(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return source;
  return toText(source).replace(/\n{3,}/g, "\n\n").trim();
}
