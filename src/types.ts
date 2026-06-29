/**
 * Shared types for the msg -> markdown pipeline.
 */

/** A single email address with an optional display name. */
export interface Address {
  name?: string;
  email?: string;
}

/** Structured representation of a parsed Outlook .msg file. */
export interface ParsedEmail {
  subject: string;
  from: Address;
  to: Address[];
  cc: Address[];
  /** ISO-8601 date string, or empty when the .msg carries no date. */
  date: string;
  /** File names of the message attachments. */
  attachments: string[];
  /** Plain-text body, when present. */
  bodyText?: string;
  /** HTML body, when present. Preferred over `bodyText` for rendering. */
  bodyHtml?: string;
}

/** Outcome of processing one input file. */
export interface ConversionResult {
  sourceFile: string;
  outputFile?: string;
  status: "converted" | "skipped";
  error?: string;
}
