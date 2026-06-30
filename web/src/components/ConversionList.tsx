import { useMemo, useState } from "react";
import JSZip from "jszip";
import { MD_BUCKET, MSG_BUCKET, supabase } from "../lib/supabase.ts";
import type { Conversion } from "../lib/types.ts";
import {
  IconArchive,
  IconCopy,
  IconDownload,
  IconEye,
  IconInbox,
  IconRefresh,
  IconSearch,
  IconTrash,
  IconX,
} from "./icons.tsx";

interface Props {
  conversions: Conversion[];
  onChange: () => void | Promise<void>;
  onToast: (kind: "ok" | "err" | "info", text: string) => void;
}

function mdName(sourceName: string): string {
  return sourceName.replace(/\.msg$/i, "") + ".md";
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString("tr-TR", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtSize(n: number | null): string | null {
  if (!n && n !== 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function triggerDownload(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const STATUS_LABEL: Record<Conversion["status"], string> = {
  done: "Tamam",
  pending: "İşleniyor",
  error: "Hata",
};

export function ConversionList({ conversions, onChange, onToast }: Props) {
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Conversion | null>(null);
  const [zipping, setZipping] = useState(false);

  const done = useMemo(
    () => conversions.filter((c) => c.status === "done" && c.markdown),
    [conversions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("tr");
    if (!q) return conversions;
    return conversions.filter(
      (c) =>
        c.source_name.toLocaleLowerCase("tr").includes(q) ||
        (c.subject ?? "").toLocaleLowerCase("tr").includes(q),
    );
  }, [conversions, query]);

  async function downloadAllZip() {
    if (done.length === 0) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      const used = new Map<string, number>();
      for (const c of done) {
        const baseName = mdName(c.source_name);
        const seen = used.get(baseName) ?? 0;
        const name = seen > 0 ? baseName.replace(/\.md$/, `-${seen}.md`) : baseName;
        used.set(baseName, seen + 1);
        zip.file(name, c.markdown ?? "");
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "msgmd-export.zip";
      a.click();
      URL.revokeObjectURL(url);
      onToast("ok", `${done.length} dosya ZIP olarak indirildi`);
    } finally {
      setZipping(false);
    }
  }

  async function copyMarkdown(c: Conversion) {
    try {
      await navigator.clipboard.writeText(c.markdown ?? "");
      onToast("ok", "Markdown panoya kopyalandı");
    } catch {
      onToast("err", "Kopyalanamadı");
    }
  }

  async function remove(c: Conversion) {
    await supabase.storage.from(MSG_BUCKET).remove([c.storage_path]);
    if (c.output_path) {
      await supabase.storage.from(MD_BUCKET).remove([c.output_path]);
    }
    const { error } = await supabase.from("conversions").delete().eq("id", c.id);
    if (error) {
      onToast("err", "Silinemedi: " + error.message);
      return;
    }
    if (preview?.id === c.id) setPreview(null);
    await onChange();
  }

  if (conversions.length === 0) {
    return (
      <section className="card pad">
        <div className="empty">
          <div className="e-ic">
            <IconInbox size={24} />
          </div>
          <p>Henüz dönüştürme yok.</p>
          <p className="small muted">Yukarıdan .msg dosyalarını yükle.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="card pad">
      <div className="section-head">
        <h2>
          Dönüştürmeler <span className="count-pill">{conversions.length}</span>
        </h2>
        <div className="head-actions">
          <button
            className="btn-primary btn-sm"
            type="button"
            disabled={done.length === 0 || zipping}
            onClick={downloadAllZip}
          >
            <IconArchive size={15} />
            {zipping ? "Hazırlanıyor…" : `Tümünü indir (${done.length})`}
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={() => onChange()}
            title="Yenile"
            aria-label="Yenile"
          >
            <IconRefresh size={17} />
          </button>
        </div>
      </div>

      {conversions.length > 5 && (
        <div className="search">
          <IconSearch size={16} />
          <input
            type="text"
            placeholder="Dosya adı veya konu ara…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      <ul className="rows">
        {filtered.map((c) => (
          <li key={c.id} className="row">
            <span className={`chip ${c.status}`}>
              <span className="cdot" />
              {STATUS_LABEL[c.status]}
            </span>
            <div className="row-main">
              <div className="row-name">{c.source_name}</div>
              {c.subject && <div className="row-sub">{c.subject}</div>}
              <div className="row-meta">
                <span>{fmtDate(c.created_at)}</span>
                {fmtSize(c.size_bytes) && <span>{fmtSize(c.size_bytes)}</span>}
              </div>
              {c.status === "error" && c.error && (
                <p className="notice err small row-err">{c.error}</p>
              )}
            </div>
            <div className="row-actions">
              {c.status === "done" && (
                <>
                  <button
                    className="icon-btn"
                    type="button"
                    onClick={() => setPreview(c)}
                    title="Önizle"
                    aria-label="Önizle"
                  >
                    <IconEye size={17} />
                  </button>
                  <button
                    className="icon-btn"
                    type="button"
                    onClick={() => triggerDownload(mdName(c.source_name), c.markdown ?? "")}
                    title="İndir"
                    aria-label="İndir"
                  >
                    <IconDownload size={17} />
                  </button>
                </>
              )}
              <button
                className="icon-btn danger"
                type="button"
                onClick={() => remove(c)}
                title="Sil"
                aria-label="Sil"
              >
                <IconTrash size={17} />
              </button>
            </div>
          </li>
        ))}
        {filtered.length === 0 && (
          <li className="empty small">Aramayla eşleşen sonuç yok.</li>
        )}
      </ul>

      {preview && (
        <div className="overlay" onClick={() => setPreview(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{preview.subject || preview.source_name}</h3>
              <div className="modal-actions">
                <button
                  className="btn-subtle btn-sm"
                  type="button"
                  onClick={() => copyMarkdown(preview)}
                >
                  <IconCopy size={15} /> Kopyala
                </button>
                <button
                  className="btn-subtle btn-sm"
                  type="button"
                  onClick={() =>
                    triggerDownload(mdName(preview.source_name), preview.markdown ?? "")
                  }
                >
                  <IconDownload size={15} /> İndir
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={() => setPreview(null)}
                  aria-label="Kapat"
                >
                  <IconX size={17} />
                </button>
              </div>
            </div>
            <div className="modal-body">
              <pre className="preview">{preview.markdown}</pre>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
