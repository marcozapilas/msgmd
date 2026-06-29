/** A row of the `conversions` table. */
export interface Conversion {
  id: string;
  user_id: string;
  source_name: string;
  storage_path: string;
  output_path: string | null;
  status: "pending" | "done" | "error";
  error: string | null;
  subject: string | null;
  markdown: string | null;
  size_bytes: number | null;
  created_at: string;
}
