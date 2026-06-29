import { readFileSync } from "node:fs";
import * as MsgReaderModule from "@kenjiuno/msgreader";
import type { FieldsData } from "@kenjiuno/msgreader";

/** Minimal shape we rely on from the msgreader class. */
interface MsgReaderInstance {
  getFileData(): FieldsData;
}
type MsgReaderCtor = new (input: Uint8Array) => MsgReaderInstance;

/**
 * The package is CommonJS, and different runtimes (tsx vs. compiled Node ESM)
 * wrap the default export in a different number of interop layers. Unwrap
 * nested `default` properties until the actual constructor surfaces.
 */
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
import type { Address, ParsedEmail } from "./types.js";

/**
 * Read and parse a single Outlook .msg file into a structured {@link ParsedEmail}.
 *
 * Throws when the file cannot be read or the .msg structure is corrupted, so the
 * caller can skip the file and continue with the rest of the batch.
 */
export function parseMsgFile(filePath: string): ParsedEmail {
  const buffer = readFileSync(filePath);

  let data: FieldsData;
  try {
    const reader = new MsgReader(buffer);
    data = reader.getFileData();
  } catch (cause) {
    throw new Error(`Not a readable .msg file: ${(cause as Error).message}`);
  }

  // msgreader reports structural problems via the `error` field instead of throwing.
  if (data.error) {
    throw new Error(data.error);
  }
  if (data.dataType !== "msg") {
    throw new Error("File does not contain an Outlook message");
  }

  const recipients = data.recipients ?? [];
  const to: Address[] = [];
  const cc: Address[] = [];
  for (const r of recipients) {
    const address: Address = { name: clean(r.name), email: clean(r.email) };
    if (r.recipType === "cc") {
      cc.push(address);
    } else if (r.recipType === "bcc") {
      // Bcc recipients are intentionally not exposed in the rendered output.
      continue;
    } else {
      to.push(address);
    }
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

/** Pick the best available date and normalise it to an ISO-8601 string. */
function extractDate(data: FieldsData): string {
  const raw =
    data.messageDeliveryTime ??
    data.clientSubmitTime ??
    data.creationTime ??
    dateFromHeaders(data.headers);
  if (!raw) {
    return "";
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? String(raw) : parsed.toISOString();
}

/** Fallback: pull the `Date:` line out of the raw transport headers. */
function dateFromHeaders(headers: string | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }
  const match = headers.match(/^Date:\s*(.+)$/im);
  return match ? match[1].trim() : undefined;
}

/** Resolve an HTML body from either the decoded string or the raw byte buffer. */
function extractHtml(data: FieldsData): string | undefined {
  if (data.bodyHtml && data.bodyHtml.trim()) {
    return data.bodyHtml;
  }
  if (data.html && data.html.byteLength > 0) {
    // `html` is the raw PR_HTML stream; decode it as UTF-8 to keep Turkish glyphs.
    return new TextDecoder("utf-8").decode(data.html);
  }
  return undefined;
}

/** Trim whitespace and treat empty strings as "absent". */
function clean(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
