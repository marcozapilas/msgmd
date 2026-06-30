/**
 * Browser .msg -> Markdown converter.
 *
 * Mirrors src/core/converter.ts (the CLI core). It lives inside web/ so its
 * `@kenjiuno/msgreader` / `turndown` imports resolve from web/node_modules and
 * play nicely with Vite's browser polyfills. Keep the two in sync if you change
 * conversion behaviour.
 */
import * as MsgReaderModule from "@kenjiuno/msgreader";
import type { FieldsData } from "@kenjiuno/msgreader";
import TurndownService from "turndown";

export interface Address {
  name?: string;
  email?: string;
}

export interface ParsedEmail {
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  date: string;
  attachments: string[];
  bodyText?: string;
  bodyHtml?: string;
}

interface MsgReaderInstance {
  getFileData(): FieldsData;
}
type MsgReaderCtor = new (input: Uint8Array) => MsgReaderInstance;

function resolveConstructor(mod: unknown): MsgReaderCtor {
  let candidate: unknown = mod;
  for (let depth = 0; depth < 5 && typeof candidate !== "function"; depth += 1) {
    candidate = (candidate as { default?: unknown })?.default;
  }
  if (typeof candidate !== "function") {
    throw new Error("Could not locate the MsgReader constructor");
  }
  return candidate as MsgReaderCtor;
}

const MsgReader = resolveConstructor(MsgReaderModule);

export function parseMsgBytes(bytes: Uint8Array): ParsedEmail {
  let data: FieldsData;
  try {
    data = new MsgReader(bytes).getFileData();
  } catch (cause) {
    throw new Error(`Not a readable .msg file: ${(cause as Error).message}`);
  }

  if (data.error) throw new Error(data.error);
  if (data.dataType !== "msg") {
    throw new Error("File does not contain an Outlook message");
  }

  const recipients = data.recipients ?? [];
  const to: Address[] = [];
  const cc: Address[] = [];
  for (const r of recipients) {
    const address: Address = { name: clean(r.name), email: clean(r.email) };
    if (r.recipType === "cc") cc.push(address);
    else if (r.recipType === "bcc") continue;
    else to.push(address);
  }

  const attachments = (data.attachments ?? [])
    .map((a) => clean(a.fileName) ?? clean(a.name))
    .filter((name): name is string => Boolean(name));

  return {
    subject: clean(data.subject) ?? "(no subject)",
    from: {
      name: clean(data.senderName),
      email: clean(data.senderSmtpAddress) ?? clean(data.senderEmail),
    },
    to,
    cc,
    date: extractDate(data),
    attachments,
    bodyText: clean(data.body),
    bodyHtml: extractHtml(data),
  };
}

function extractDate(data: FieldsData): string {
  const raw =
    data.messageDeliveryTime ??
    data.clientSubmitTime ??
    data.creationTime ??
    dateFromHeaders(data.headers);
  if (!raw) return "";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? String(raw) : parsed.toISOString();
}

function dateFromHeaders(headers: string | undefined): string | undefined {
  if (!headers) return undefined;
  const match = headers.match(/^Date:\s*(.+)$/im);
  return match ? match[1].trim() : undefined;
}

function extractHtml(data: FieldsData): string | undefined {
  if (data.bodyHtml && data.bodyHtml.trim()) return data.bodyHtml;
  if (data.html && data.html.byteLength > 0) {
    return new TextDecoder("utf-8").decode(data.html);
  }
  return undefined;
}

function clean(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});
turndown.remove(["style", "script", "head", "title", "meta"]);

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

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

export function renderBody(email: ParsedEmail): string {
  if (email.bodyHtml) {
    const md = htmlToMarkdown(email.bodyHtml);
    if (md) return md;
  }
  if (email.bodyText) return plainTextToMarkdown(email.bodyText);
  return "_(no body content)_";
}

export function buildMarkdown(email: ParsedEmail): string {
  const lines: string[] = [];
  lines.push(`# ${escapeInline(email.subject)}`, "");
  lines.push("## Details", "");
  lines.push(`- **From:** ${formatAddress(email.from)}`);
  lines.push(`- **To:** ${formatAddressList(email.to)}`);
  if (email.cc.length > 0) lines.push(`- **Cc:** ${formatAddressList(email.cc)}`);
  lines.push(`- **Date:** ${email.date || "(unknown)"}`, "");
  lines.push("## Attachments", "");
  if (email.attachments.length > 0) {
    for (const name of email.attachments) lines.push(`- ${escapeInline(name)}`);
  } else {
    lines.push("- _(none)_");
  }
  lines.push("", "## Body", "", renderBody(email), "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

export function convertMsgToMarkdown(bytes: Uint8Array): {
  email: ParsedEmail;
  markdown: string;
} {
  const email = parseMsgBytes(bytes);
  return { email, markdown: buildMarkdown(email) };
}

function formatAddressList(addresses: Address[]): string {
  if (addresses.length === 0) return "(none)";
  return addresses.map(formatAddress).join(", ");
}

function formatAddress(address: Address): string {
  const name = address.name ? escapeInline(address.name) : undefined;
  const email = address.email ? escapeInline(address.email) : undefined;
  if (name && email) return `${name} <${email}>`;
  return name ?? email ?? "(unknown)";
}

function escapeInline(value: string): string {
  return value.replace(/([\\`*_<>])/g, "\\$1").replace(/\s+/g, " ").trim();
}
