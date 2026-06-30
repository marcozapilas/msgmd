import { useCallback, useMemo, useRef, useState } from "react";
import { CONVERT_FUNCTION, MSG_BUCKET, supabase } from "../lib/supabase.ts";
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
  status: Status;
  error?: string;
  conversionId?: string;
  storagePath?: string;
}

const CONCURRENCY = 4;

const STAGE_LABEL: Record<Status, string> = {
  queued: "Sırada bekliyor",
  uploading: "Yükleniyor",
  converting: "Dönüştürülüyor",
  done: "Tamamlandı",
  error: "Hata",
  cancelled: "İptal edildi",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function Uploader({ userId, onDone, onToast }: Props) {
  const [items, setItemsState] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const itemsRef = useRef<Item[]>([]);
  const cancelled = useRef<Set<string>>(new Set());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const batchDone = useRef({ ok: 0, err: 0, total: 0 });

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

  // Debounced history refresh so a big batch doesn't spam the DB.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void onDone(), 500);
  }, [onDone]);

  const announceIfBatchEnded = useCallback(() => {
    const active = itemsRef.current.some(
      (it) => it.status === "uploading" || it.status === "converting" || it.status === "queued",
    );
    if (!active && batchDone.current.total > 0) {
      const { ok, err } = batchDone.current;
      if (ok > 0 && err === 0) onToast("ok", `${ok} dosya dönüştürüldü`);
      else if (ok > 0 && err > 0) onToast("info", `${ok} tamam, ${err} başarısız`);
      else if (err > 0) onToast("err", `${err} dosya dönüştürülemedi`);
      batchDone.current = { ok: 0, err: 0, total: 0 };
    }
  }, [onToast]);

  const runItem = useCallback(
    async (id: string, file: File) => {
      const convId = crypto.randomUUID();
      const path = `${userId}/${convId}.msg`;
      const isCancelled = () => cancelled.current.has(id);
      try {
        if (isCancelled()) throw { cancelled: true };
        const { error: upErr } = await supabase.storage
          .from(MSG_BUCKET)
          .upload(path, file, {
            contentType: "application/vnd.ms-outlook",
            upsert: false,
          });
        if (upErr) throw upErr;
        patch(id, { conversionId: convId, storagePath: path });

        if (isCancelled()) {
          await supabase.storage.from(MSG_BUCKET).remove([path]);
          throw { cancelled: true };
        }

        const { error: insErr } = await supabase.from("conversions").insert({
          id: convId,
          user_id: userId,
          source_name: file.name,
          storage_path: path,
          size_bytes: file.size,
          status: "pending",
        });
        if (insErr) throw insErr;
        patch(id, { status: "converting" });

        const { error: fnErr } = await supabase.functions.invoke(
          CONVERT_FUNCTION,
          { body: { conversionId: convId } },
        );
        if (fnErr) throw fnErr;

        patch(id, { status: "done" });
        batchDone.current.ok += 1;
      } catch (err: unknown) {
        if (err && typeof err === "object" && "cancelled" in err) {
          patch(id, { status: "cancelled" });
        } else {
          patch(id, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
          batchDone.current.err += 1;
        }
      } finally {
        scheduleRefresh();
        pump();
        announceIfBatchEnded();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userId, patch, scheduleRefresh, announceIfBatchEnded],
  );

  // Fill open slots up to CONCURRENCY from the queued items.
  const pump = useCallback(() => {
    const list = itemsRef.current;
    let active = list.filter(
      (it) => it.status === "uploading" || it.status === "converting",
    ).length;
    for (const it of list) {
      if (active >= CONCURRENCY) break;
      if (it.status !== "queued") continue;
      if (cancelled.current.has(it.id)) {
        patch(it.id, { status: "cancelled" });
        continue;
      }
      active += 1;
      patch(it.id, { status: "uploading" });
      void runItem(it.id, it.file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patch, runItem]);

  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter((f) =>
        f.name.toLowerCase().endsWith(".msg"),
      );
      const skipped = Array.from(fileList).length - files.length;
      if (skipped > 0) {
        onToast("info", `${skipped} dosya .msg olmadığı için atlandı`);
      }
      if (files.length === 0) return;
      batchDone.current.total += files.length;
      const newItems: Item[] = files.map((f) => ({
        id: crypto.randomUUID(),
        file: f,
        status: "queued",
      }));
      setItems((prev) => [...prev, ...newItems]);
      setTimeout(pump, 0);
    },
    [onToast, pump, setItems],
  );

  const cancelItem = useCallback(
    (id: string) => {
      cancelled.current.add(id);
      const item = itemsRef.current.find((it) => it.id === id);
      if (item && item.status === "queued") {
        patch(id, { status: "cancelled" });
      }
    },
    [patch],
  );

  const cancelAll = useCallback(() => {
    for (const it of itemsRef.current) {
      if (it.status === "queued" || it.status === "uploading" || it.status === "converting") {
        cancelled.current.add(it.id);
        if (it.status === "queued") patch(it.id, { status: "cancelled" });
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

  const stats = useMemo(() => {
    const s = { done: 0, active: 0, queued: 0, error: 0 };
    for (const it of items) {
      if (it.status === "done") s.done += 1;
      else if (it.status === "uploading" || it.status === "converting") s.active += 1;
      else if (it.status === "queued") s.queued += 1;
      else if (it.status === "error") s.error += 1;
    }
    return s;
  }, [items]);

  const total = items.length;
  const settled = items.filter(
    (it) => it.status === "done" || it.status === "error" || it.status === "cancelled",
  ).length;
  const pct = total === 0 ? 0 : Math.round((settled / total) * 100);
  const hasActive = stats.active > 0 || stats.queued > 0;
  const hasFinished = items.some(
    (it) => it.status === "done" || it.status === "error" || it.status === "cancelled",
  );

  return (
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
      <p className="dz-title">.msg dosyalarını buraya sürükle</p>
      <p className="dz-or">veya</p>
      <button
        className="btn-primary"
        type="button"
        onClick={() => inputRef.current?.click()}
      >
        <IconUpload size={16} /> Dosya seç
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
      <p className="dz-hint">Birden fazla dosya seçebilirsin · aynı anda 4 işlenir</p>

      {total > 0 && (
        <div className="queue">
          <div className="queue-head">
            <div className="queue-stats">
              <span className="stat">
                <span className="dot done" />
                <b>{stats.done}</b> tamam
              </span>
              {stats.active > 0 && (
                <span className="stat">
                  <span className="dot active" />
                  <b>{stats.active}</b> işleniyor
                </span>
              )}
              {stats.queued > 0 && (
                <span className="stat">
                  <span className="dot queued" />
                  <b>{stats.queued}</b> bekliyor
                </span>
              )}
              {stats.error > 0 && (
                <span className="stat">
                  <span className="dot error" />
                  <b>{stats.error}</b> hata
                </span>
              )}
            </div>
            <div className="head-actions">
              {hasActive && (
                <button className="btn-subtle btn-sm" type="button" onClick={cancelAll}>
                  Tümünü iptal et
                </button>
              )}
              {hasFinished && (
                <button className="btn-subtle btn-sm" type="button" onClick={clearFinished}>
                  Tamamlananları temizle
                </button>
              )}
            </div>
          </div>

          <div className="overall-bar">
            <div className="overall-fill" style={{ width: `${pct}%` }} />
          </div>

          <ul className="q-list">
            {items.map((it) => (
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
                      {it.status === "error" && it.error
                        ? it.error
                        : STAGE_LABEL[it.status]}
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
                    aria-label="İptal"
                    title="İptal et"
                  >
                    <IconX size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
