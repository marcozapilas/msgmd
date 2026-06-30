// Supabase Edge Function: convert-msg
//
// Self-contained on purpose: it uses only `npm:` imports and inlines the
// conversion logic so it can be deployed straight from the Supabase Dashboard
// (Edge Functions → Deploy a new function) WITHOUT installing any CLI/Docker.
// The logic mirrors src/core/converter.ts (the CLI's shared core); keep the two
// in sync if you change conversion behaviour.
//
// It downloads a previously-uploaded .msg from the `msg-uploads` bucket,
// converts it to Markdown, stores the .md in `md-outputs`, and updates the
// matching `conversions` row. All access runs with the caller's JWT so
// row-level security applies — the function never uses the service role.
import { createClient } from "npm:@supabase/supabase-js@2";
import MsgReaderImport from "npm:@kenjiuno/msgreader@1.22.0";
import TurndownService from "npm:turndown@7.2.0";

/* ------------------------------ conversion core --------------------------- */

// msgreader is CommonJS; unwrap nested interop `default` layers to the class.
function resolveConstructor(mod: unknown): new (input: Uint8Array) => {
  getFileData(): any;
} {
  let candidate: unknown = mod;
  for (let i = 0; i < 5 && typeof candidate !== "function"; i++) {
    candidate = (candidate as { default?: unknown })?.default;
  }
  if (typeof candidate !== "function") {
    throw new Error("Could not locate the MsgReader constructor");
  }
  return candidate as any;
}
const MsgReader = resolveConstructor(MsgReaderImport);

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});
turndown.remove(["style", "script", "head", "title", "meta"]);

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).replace(/\n{3,}/g, "\n\n").trim();
}

function plainTextToMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeInline(value: string): string {
  return value.replace(/([\\`*_<>])/g, "\\$1").replace(/\s+/g, " ").trim();
}

interface Address {
  name?: string;
  email?: string;
}

function formatAddress(a: Address): string {
  const name = a.name ? escapeInline(a.name) : undefined;
  const email = a.email ? escapeInline(a.email) : undefined;
  if (name && email) return `${name} <${email}>`;
  return name ?? email ?? "(unknown)";
}

function formatAddressList(list: Address[]): string {
  return list.length === 0 ? "(none)" : list.map(formatAddress).join(", ");
}

function convertMsgToMarkdown(bytes: Uint8Array): {
  subject: string;
  markdown: string;
} {
  let data: any;
  try {
    data = new MsgReader(bytes).getFileData();
  } catch (cause) {
    throw new Error(`Not a readable .msg file: ${(cause as Error).message}`);
  }
  if (data.error) throw new Error(data.error);
  if (data.dataType !== "msg") {
    throw new Error("File does not contain an Outlook message");
  }

  const to: Address[] = [];
  const cc: Address[] = [];
  for (const r of data.recipients ?? []) {
    const addr: Address = { name: clean(r.name), email: clean(r.email) };
    if (r.recipType === "cc") cc.push(addr);
    else if (r.recipType === "bcc") continue;
    else to.push(addr);
  }

  const attachments: string[] = (data.attachments ?? [])
    .map((a: any) => clean(a.fileName) ?? clean(a.name))
    .filter((n: unknown): n is string => Boolean(n));

  const subject = clean(data.subject) ?? "(no subject)";
  const from: Address = {
    name: clean(data.senderName),
    email: clean(data.senderSmtpAddress) ?? clean(data.senderEmail),
  };

  let date = "";
  const rawDate =
    data.messageDeliveryTime ?? data.clientSubmitTime ?? data.creationTime;
  if (rawDate) {
    const d = new Date(rawDate);
    date = Number.isNaN(d.getTime()) ? String(rawDate) : d.toISOString();
  }

  let body = "";
  const html =
    clean(data.bodyHtml) ??
    (data.html && data.html.byteLength > 0
      ? new TextDecoder("utf-8").decode(data.html)
      : undefined);
  if (html) body = htmlToMarkdown(html);
  if (!body && clean(data.body)) body = plainTextToMarkdown(data.body);
  if (!body) body = "_(no body content)_";

  const lines: string[] = [];
  lines.push(`# ${escapeInline(subject)}`, "");
  lines.push("## Details", "");
  lines.push(`- **From:** ${formatAddress(from)}`);
  lines.push(`- **To:** ${formatAddressList(to)}`);
  if (cc.length > 0) lines.push(`- **Cc:** ${formatAddressList(cc)}`);
  lines.push(`- **Date:** ${date || "(unknown)"}`, "");
  lines.push("## Attachments", "");
  if (attachments.length > 0) {
    for (const n of attachments) lines.push(`- ${escapeInline(n)}`);
  } else {
    lines.push("- _(none)_");
  }
  lines.push("", "## Body", "", body, "");

  const markdown = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  return { subject, markdown };
}

/* ------------------------------- HTTP handler ----------------------------- */

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
    conversionId = (await req.json())?.conversionId;
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
    const { subject, markdown } = convertMsgToMarkdown(bytes);

    const outputPath = row.storage_path.replace(/\.msg$/i, ".md");
    const { error: upError } = await supabase.storage
      .from("md-outputs")
      .upload(outputPath, new Blob([markdown], { type: "text/markdown" }), {
        upsert: true,
        contentType: "text/markdown; charset=utf-8",
      });
    if (upError) throw new Error(upError.message);

    const { error: updError } = await supabase
      .from("conversions")
      .update({
        status: "done",
        subject,
        markdown,
        output_path: outputPath,
        error: null,
      })
      .eq("id", conversionId);
    if (updError) throw new Error(updError.message);

    return json({ ok: true, subject, markdown });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Best-effort: record the failure so the UI can show it.
    await supabase
      .from("conversions")
      .update({ status: "error", error: message })
      .eq("id", conversionId);
    return json({ error: message }, 422);
  }
});
