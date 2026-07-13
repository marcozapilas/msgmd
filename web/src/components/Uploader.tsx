import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase.ts";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconSpinner,
  IconUpload,
  IconX,
} from "./icons.tsx";

interface Props {
  userId: string;
  onDone: () => void | Promise<void>;
  onToast: (kind: "ok" | "err" | "info", text: string) => void;
  onConverted?: () => void;
}

type Status =
  | "queued"
  | "uploading"
  | "converting"
  | "done"
  | "error"
  | "cancelled";

interface Item {
  id: string;
  file: File;
  batchId: string;
  status: Status;
  error?: string;
}

const CONCURRENCY = 3;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mirror of the M0 backfill address rules: an X.500 DN (or anything without
// "@") is never persisted in an email field; the metadata payload therefore
// can never contradict the generated markdown.
const emailOrNull = (v?: string) => (v && v.includes("@") ? v : null);
const toRecipient = (a: { name?: string; email?: string }) => ({
  name: a.name ?? null,
  email: emailOrNull(a.email),
});

// Lazy-load the (heavy) converter only when the first file is processed.
type Converter = typeof import("../lib/converter.ts");
let converterPromise: Promise<Converter> | null = null;
function loadConverter(): Promise<Converter> {
  converterPromise ??= import("../lib/converter.ts");
  return converterPromise;
}

/** Run a Supabase call that resolves to `{ error }`, retrying with backoff. */
async function runStep(
  fn: () => Promise<{ error: unknown }>,
  isCancelled: () => boolean,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (isCancelled()) throw { cancelled: true };
    const { error } = await fn();
    if (!error) return;
    lastErr = error;
    if (attempt < MAX_ATTEMPTS - 1) await sleep(700 * 2 ** attempt);
  }
  throw lastErr;
}

const STAGE_LABEL: Record<Status, string> = {
  queued: "Queued",
  uploading: "Reading",
  converting: "Saving",
  done: "Done",
  error: "Error",
  cancelled: "Cancelled",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Uploader({ userId, onDone, onToast, onConverted }: Props) {
  const [items, setItemsState] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const [pageDrag, setPageDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const itemsRef = useRef<Item[]>([]);
  const cancelled = useRef<Set<string>>(new Set());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchTally = useRef({ ok: 0, err: 0, total: 0 });
  // Concurrency is tracked with plain refs (not React state) so scheduling
  // never depends on render timing — the queue can't stall at scale.
  const pending = useRef<{ id: string; file: File; batchId: string }[]>([]);
  const active = useRef(0);

  const setItems = useCallback((updater: (prev: Item[]) => Item[]) => {
    setItemsState((prev) => {
      const next = updater(prev);
      itemsRef.current = next;
      return next;
    });
  }, []);

  const patch = useCallback(
    (id: string, p: Partial<Item>) => {
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...p } : it)));
    },
    [setItems],
  );

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void onDone(), 500);
  }, [onDone]);

  const announceIfBatchEnded = useCallback(() => {
    const stillWorking = active.current > 0 || pending.current.length > 0;
    if (!stillWorking && batchTally.current.total > 0) {
      const { ok, err } = batchTally.current;
      if (ok > 0 && err === 0) onToast("ok", `${ok} file(s) converted`);
      else if (ok > 0 && err > 0) onToast("info", `${ok} done, ${err} failed`);
      else if (err > 0) onToast("err", `${err} file(s) failed to convert`);
      batchTally.current = { ok: 0, err: 0, total: 0 };
      if (ok > 0) onConverted?.();
    }
  }, [onToast, onConverted]);

  const runItem = useCallback(
    async (id: string, file: File, batchId: string) => {
      const convId = crypto.randomUUID();
      const isCancelled = () => cancelled.current.has(id);
      try {
        if (isCancelled()) throw { cancelled: true };

        // 1) Parse + render entirely in the browser.
        const { convertMsgToMarkdown } = await loadConverter();
        const bytes = new Uint8Array(await file.arrayBuffer());
        let subject: string;
        let markdown: string;
        let senderName: string | null;
        let senderEmail: string | null;
        let sentAt: string | null;
        let recipients: {
          to: ReturnType<typeof toRecipient>[];
          cc: ReturnType<typeof toRecipient>[];
        };
        try {
          const out = convertMsgToMarkdown(bytes);
          subject = out.email.subject;
          markdown = out.markdown;
          senderName = out.email.from.name ?? null;
          senderEmail = emailOrNull(out.email.from.email);
          sentAt = out.email.date || null;
          recipients = {
            to: out.email.to.map(toRecipient),
            cc: out.email.cc.map(toRecipient),
          };
        } catch (e) {
          throw new Error(
            e instanceof Error ? e.message : "Could not read .msg file",
          );
        }

        if (isCancelled()) throw { cancelled: true };
        patch(id, { status: "converting" });

        // 2) Save the result (single, idempotent network call).
        await runStep(
          async () =>
            supabase.from("conversions").upsert(
              {
                id: convId,
                user_id: userId,
                batch_id: batchId,
                source_name: file.name,
                storage_path: null,
                size_bytes: file.size,
                status: "done",
                subject,
                markdown,
                sender_name: senderName,
                sender_email: senderEmail,
                sent_at: sentAt,
                recipients,
              },
              { onConflict: "id" },
            ),
          isCancelled,
        );

        patch(id, { status: "done" });
        batchTally.current.ok += 1;
      } catch (err: unknown) {
        if (err && typeof err === "object" && "cancelled" in err) {
          patch(id, { status: "cancelled" });
        } else {
          patch(id, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
          batchTally.current.err += 1;
        }
      } finally {
        active.current = Math.max(0, active.current - 1);
        scheduleRefresh();
        pump();
        announceIfBatchEnded();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, patch, scheduleRefresh, announceIfBatchEnded],
  );

  const pump = useCallback(() => {
    while (active.current < CONCURRENCY && pending.current.length > 0) {
      const next = pending.current.shift()!;
      if (cancelled.current.has(next.id)) {
        patch(next.id, { status: "cancelled" });
        continue;
      }
      active.current += 1;
      patch(next.id, { status: "uploading" });
      void runItem(next.id, next.file, next.batchId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch, runItem]);

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const all = Array.from(fileList);
      const files = all.filter((f) => f.name.toLowerCase().endsWith(".msg"));
      const skipped = all.length - files.length;
      if (skipped > 0) onToast("info", `${skipped} non-.msg file(s) skipped`);
      if (files.length === 0) return;
      batchTally.current.total += files.length;
      const batchId = crypto.randomUUID();
      const newItems: Item[] = files.map((f) => ({
        id: crypto.randomUUID(),
        file: f,
        batchId,
        status: "queued",
      }));
      for (const it of newItems) {
        pending.current.push({ id: it.id, file: it.file, batchId });
      }
      setItems((prev) => [...prev, ...newItems]);
      pump();
    },
    [onToast, pump, setItems],
  );

  const cancelItem = useCallback(
    (id: string) => {
      cancelled.current.add(id);
      const idx = pending.current.findIndex((p) => p.id === id);
      if (idx >= 0) {
        pending.current.splice(idx, 1);
        patch(id, { status: "cancelled" });
      }
    },
    [patch],
  );

  const cancelAll = useCallback(() => {
    for (const p of pending.current) {
      cancelled.current.add(p.id);
      patch(p.id, { status: "cancelled" });
    }
    pending.current = [];
    for (const it of itemsRef.current) {
      if (it.status === "uploading" || it.status === "converting") {
        cancelled.current.add(it.id);
      }
    }
  }, [patch]);

  const clearFinished = useCallback(() => {
    setItems((prev) =>
      prev.filter(
        (it) =>
          it.status === "queued" ||
          it.status === "uploading" ||
          it.status === "converting",
      ),
    );
  }, [setItems]);

  // Full-page drag & drop.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setPageDrag(true);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setPageDrag(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setPageDrag(false);
      if (e.dataTransfer?.files?.length) {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [addFiles]);

  const stats = useMemo(() => {
    const s = { done: 0, active: 0, queued: 0, error: 0 };
    for (const it of items) {
      if (it.status === "done") s.done += 1;
      else if (it.status === "uploading" || it.status === "converting")
        s.active += 1;
      else if (it.status === "queued") s.queued += 1;
      else if (it.status === "error") s.error += 1;
    }
    return s;
  }, [items]);

  // Only ever render the handful of in-flight items and a capped list of
  // failures — never the full queue (thousands of rows would freeze the tab).
  const activeItems = useMemo(
    () =>
      items.filter(
        (it) => it.status === "uploading" || it.status === "converting",
      ),
    [items],
  );
  const errorItems = useMemo(
    () => items.filter((it) => it.status === "error"),
    [items],
  );

  const total = items.length;
  const settled = items.filter(
    (it) =>
      it.status === "done" ||
      it.status === "error" ||
      it.status === "cancelled",
  ).length;
  const pct = total === 0 ? 0 : Math.round((settled / total) * 100);
  const hasActive = stats.active > 0 || stats.queued > 0;
  const hasFinished = items.some(
    (it) =>
      it.status === "done" ||
      it.status === "error" ||
      it.status === "cancelled",
  );

  const renderItem = (it: Item) => (
    <li key={it.id} className="q-item">
      <span className={`q-ic ${it.status}`}>
        {it.status === "done" ? (
          <IconCheck size={16} />
        ) : it.status === "error" ? (
          <IconAlert size={16} />
        ) : it.status === "cancelled" ? (
          <IconX size={16} />
        ) : it.status === "queued" ? (
          <IconClock size={16} />
        ) : (
          <IconSpinner size={16} />
        )}
      </span>
      <div className="q-body">
        <div className="q-name">{it.file.name}</div>
        <div className="q-meta">
          <span>{formatBytes(it.file.size)}</span>
          <span>·</span>
          <span className="q-stage">
            {it.status === "error" && it.error ? it.error : STAGE_LABEL[it.status]}
          </span>
        </div>
        {(it.status === "uploading" || it.status === "converting") && (
          <div className="mini-bar">
            <div className="mini-fill" />
          </div>
        )}
      </div>
      {(it.status === "queued" ||
        it.status === "uploading" ||
        it.status === "converting") && (
        <button
          className="icon-btn danger"
          type="button"
          onClick={() => cancelItem(it.id)}
          aria-label="Cancel"
          title="Cancel"
        >
          <IconX size={16} />
        </button>
      )}
    </li>
  );

  return (
    <>
      {pageDrag && (
        <div className="page-drop">
          <div className="page-drop-card">
            <IconUpload size={34} />
            <p>Drop .msg files anywhere</p>
          </div>
        </div>
      )}

      <section
        className={`dropzone ${dragging ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <div className="dz-icon">
          <IconUpload size={26} />
        </div>
        <p className="dz-title">Drag &amp; drop your .msg files</p>
        <p className="dz-or">or</p>
        <button
          className="btn-primary"
          type="button"
          onClick={() => inputRef.current?.click()}
        >
          <IconUpload size={16} /> Choose files
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".msg"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <p className="dz-hint">
          Converted privately in your browser · each upload is its own batch
        </p>

        {total > 0 && (
          <div className="queue">
            <div className="queue-head">
              <div className="queue-stats">
                <span className="stat">
                  <span className="dot done" />
                  <b>{stats.done}</b> done
                </span>
                {stats.active > 0 && (
                  <span className="stat">
                    <span className="dot active" />
                    <b>{stats.active}</b> processing
                  </span>
                )}
                {stats.queued > 0 && (
                  <span className="stat">
                    <span className="dot queued" />
                    <b>{stats.queued}</b> queued
                  </span>
                )}
                {stats.error > 0 && (
                  <span className="stat">
                    <span className="dot error" />
                    <b>{stats.error}</b> failed
                  </span>
                )}
              </div>
              <div className="head-actions">
                {hasActive && (
                  <button
                    className="btn-subtle btn-sm"
                    type="button"
                    onClick={cancelAll}
                  >
                    Cancel all
                  </button>
                )}
                {hasFinished && (
                  <button
                    className="btn-subtle btn-sm"
                    type="button"
                    onClick={clearFinished}
                  >
                    Clear finished
                  </button>
                )}
              </div>
            </div>

            <div className="overall-bar">
              <div className="overall-fill" style={{ width: `${pct}%` }} />
            </div>

            {activeItems.length > 0 && (
              <ul className="q-list">{activeItems.map(renderItem)}</ul>
            )}
            {errorItems.length > 0 && (
              <>
                <div className="q-subhead">Failed ({errorItems.length})</div>
                <ul className="q-list">
                  {errorItems.slice(0, 8).map(renderItem)}
                  {errorItems.length > 8 && (
                    <li className="q-more">
                      +{errorItems.length - 8} more failed
                    </li>
                  )}
                </ul>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
