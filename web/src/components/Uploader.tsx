import { useRef, useState } from "react";
import { MSG_BUCKET, supabase } from "../lib/supabase.ts";

interface Props {
  userId: string;
  onDone: () => void | Promise<void>;
}

interface ItemState {
  name: string;
  status: "uploading" | "converting" | "done" | "error";
  error?: string;
}

export function Uploader({ userId, onDone }: Props) {
  const [dragging, setDragging] = useState(false);
  const [items, setItems] = useState<ItemState[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function update(index: number, patch: Partial<ItemState>) {
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, ...patch } : it)),
    );
  }

  async function processOne(file: File, index: number): Promise<void> {
    const id = crypto.randomUUID();
    const path = `${userId}/${id}.msg`;
    try {
      const { error: upErr } = await supabase.storage
        .from(MSG_BUCKET)
        .upload(path, file, {
          contentType: "application/vnd.ms-outlook",
          upsert: false,
        });
      if (upErr) throw upErr;

      const { error: insErr } = await supabase.from("conversions").insert({
        id,
        user_id: userId,
        source_name: file.name,
        storage_path: path,
        size_bytes: file.size,
        status: "pending",
      });
      if (insErr) throw insErr;

      update(index, { status: "converting" });
      const { error: fnErr } = await supabase.functions.invoke("convert-msg", {
        body: { conversionId: id },
      });
      if (fnErr) throw fnErr;

      update(index, { status: "done" });
    } catch (err) {
      update(index, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((f) =>
      f.name.toLowerCase().endsWith(".msg"),
    );
    if (files.length === 0) {
      return;
    }
    setBusy(true);
    setItems(files.map((f) => ({ name: f.name, status: "uploading" })));
    // Process in parallel; each file is independent so one failure never
    // blocks the rest of the batch.
    await Promise.allSettled(files.map((f, i) => processOne(f, i)));
    setBusy(false);
    await onDone();
  }

  return (
    <section
      className={`card dropzone ${dragging ? "drag" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void handleFiles(e.dataTransfer.files);
      }}
    >
      <div className="dropzone-inner">
        <p className="big">.msg dosyalarını buraya sürükle</p>
        <p className="muted">veya</p>
        <button
          className="primary"
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? "İşleniyor…" : "Dosya seç"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".msg"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <p className="muted small">Birden fazla dosya seçebilirsin.</p>
      </div>

      {items.length > 0 && (
        <ul className="progress-list">
          {items.map((it, i) => (
            <li key={i} className={`progress-item ${it.status}`}>
              <span className="dot" />
              <span className="fname">{it.name}</span>
              <span className="status">
                {it.status === "uploading" && "yükleniyor…"}
                {it.status === "converting" && "dönüştürülüyor…"}
                {it.status === "done" && "tamam"}
                {it.status === "error" && (it.error ?? "hata")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
