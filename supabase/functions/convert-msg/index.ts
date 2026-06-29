// Supabase Edge Function: convert-msg
//
// Downloads a previously-uploaded .msg from the `msg-uploads` bucket, converts
// it to Markdown using the shared core, stores the .md in `md-outputs`, and
// updates the matching `conversions` row. All access runs with the caller's JWT
// so row-level security applies — the function never uses the service role.
import { createClient } from "@supabase/supabase-js";
import { convertMsgToMarkdown } from "../../../src/core/converter.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "Missing authorization header" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  let conversionId: string | undefined;
  try {
    const payload = await req.json();
    conversionId = payload?.conversionId;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!conversionId) {
    return json({ error: "conversionId is required" }, 400);
  }

  // RLS guarantees the row belongs to the caller (or returns nothing).
  const { data: row, error: rowError } = await supabase
    .from("conversions")
    .select("id, storage_path, status")
    .eq("id", conversionId)
    .single();

  if (rowError || !row) {
    return json({ error: "Conversion not found" }, 404);
  }

  try {
    const { data: blob, error: dlError } = await supabase.storage
      .from("msg-uploads")
      .download(row.storage_path);
    if (dlError || !blob) {
      throw new Error(dlError?.message ?? "Could not download source file");
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { email, markdown } = convertMsgToMarkdown(bytes);

    const outputPath = row.storage_path.replace(/\.msg$/i, ".md");
    const { error: upError } = await supabase.storage
      .from("md-outputs")
      .upload(outputPath, new Blob([markdown], { type: "text/markdown" }), {
        upsert: true,
        contentType: "text/markdown; charset=utf-8",
      });
    if (upError) {
      throw new Error(upError.message);
    }

    const { error: updError } = await supabase
      .from("conversions")
      .update({
        status: "done",
        subject: email.subject,
        markdown,
        output_path: outputPath,
        error: null,
      })
      .eq("id", conversionId);
    if (updError) {
      throw new Error(updError.message);
    }

    return json({ ok: true, subject: email.subject, markdown });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Best-effort: record the failure so the UI can show it. The file is
    // skipped, but other files in the batch keep processing client-side.
    await supabase
      .from("conversions")
      .update({ status: "error", error: message })
      .eq("id", conversionId);
    return json({ error: message }, 422);
  }
});
