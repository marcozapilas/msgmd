import TurndownService from "turndown";
import type { Address, ParsedEmail } from "./types.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

// Drop noise that never reads well in Markdown.
turndown.remove(["style", "script", "head", "title", "meta"]);

/** Convert an HTML email body into readable Markdown. */
export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Normalise a plain-text body so paragraphs and simple lists survive when the
 * text is dropped into a Markdown document.
 */
export function plainTextToMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Render the body, preferring HTML and falling back to plain text. */
export function renderBody(email: ParsedEmail): string {
  if (email.bodyHtml) {
    const md = htmlToMarkdown(email.bodyHtml);
    if (md) {
      return md;
    }
  }
  if (email.bodyText) {
    return plainTextToMarkdown(email.bodyText);
  }
  return "_(no body content)_";
}

/** Build the complete Markdown document for a parsed email. */
export function buildMarkdown(email: ParsedEmail): string {
  const lines: string[] = [];

  lines.push(`# ${escapeInline(email.subject)}`, "");

  lines.push("## Details", "");
  lines.push(`- **From:** ${formatAddress(email.from)}`);
  lines.push(`- **To:** ${formatAddressList(email.to)}`);
  if (email.cc.length > 0) {
    lines.push(`- **Cc:** ${formatAddressList(email.cc)}`);
  }
  lines.push(`- **Date:** ${email.date || "(unknown)"}`);
  lines.push("");

  lines.push("## Attachments", "");
  if (email.attachments.length > 0) {
    for (const name of email.attachments) {
      lines.push(`- ${escapeInline(name)}`);
    }
  } else {
    lines.push("- _(none)_");
  }
  lines.push("");

  lines.push("## Body", "", renderBody(email), "");

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function formatAddressList(addresses: Address[]): string {
  if (addresses.length === 0) {
    return "(none)";
  }
  return addresses.map(formatAddress).join(", ");
}

function formatAddress(address: Address): string {
  const name = address.name ? escapeInline(address.name) : undefined;
  const email = address.email ? escapeInline(address.email) : undefined;
  if (name && email) {
    return `${name} <${email}>`;
  }
  return name ?? email ?? "(unknown)";
}

/** Escape characters that would break inline Markdown in a header cell. */
function escapeInline(value: string): string {
  return value.replace(/([\\`*_<>])/g, "\\$1").replace(/\s+/g, " ").trim();
}
