/** One address in the structured `recipients` payload. */
export interface RecipientAddress {
  name: string | null;
  email: string | null;
}

/** Structured recipients payload (M0). `ambiguous` is set by the backfill for
 * lines whose entry boundaries could not be split deterministically. */
export interface Recipients {
  to: RecipientAddress[];
  cc: RecipientAddress[];
  ambiguous?: boolean;
}

/** A row of the `conversions` table. */
export interface Conversion {
  id: string;
  user_id: string;
  batch_id: string | null;
  source_name: string;
  storage_path: string | null;
  output_path: string | null;
  status: "pending" | "done" | "error";
  error: string | null;
  subject: string | null;
  markdown: string | null;
  size_bytes: number | null;
  created_at: string;
  // M0 structured email metadata (backfilled for historical rows)
  sender_name: string | null;
  sender_email: string | null;
  sent_at: string | null;
  recipients: Recipients | null;
}
