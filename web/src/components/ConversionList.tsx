import { useState } from "react";
import JSZip from "jszip";
import { MD_BUCKET, MSG_BUCKET, supabase } from "../lib/supabase.ts";
import type { Conversion } from "../lib/types.ts";

interface Props {
  conversions: Conversion[];
  onChange: () => void | Promise<void>;
}

function mdName(sourceName: string): string {
  return sourceName.replace(/\.msg$/i, "") + ".md";
}

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ConversionList({ conversions, onChange }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [zipping, setZipping] = useState(false);

  const done = conversions.filter((c) => c.status === "done" && c.markdown);

  async function downloadAllZip() {
    if (done.length === 0) return;
    setZipping(true);
    try {
      const zip = new JSZip();
      const used = new Map<string, number>();
      for (const c of done) {
        let name = mdName(c.source_name);
        // Avoid collisions inside the archive.
        const seen = used.get(name) ?? 0;
        if (seen > 0) {
          name = name.replace(/\.md$/, `-${seen}.md`);
        }
        used.set(mdName(c.source_name), seen + 1);
        zip.file(name, c.markdown ?? "");
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "msgmd-export.zip";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setZipping(false);
    }
  }

  async function remove(c: Conversion) {
    // Clean up storage objects (ignore errors — best effort), then the row.
    await supabase.storage.from(MSG_BUCKET).remove([c.storage_path]);
    if (c.output_path) {
      await supabase.storage.from(MD_BUCKET).remove([c.output_path]);
    }
    await supabase.from("conversions").delete().eq("id", c.id);
    await onChange();
  }

  if (conversions.length === 0) {
    return (
      <section className="card">
        <p className="muted">Henüz dönüştürme yok. Yukarıdan .msg yükle.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="list-head">
        <h2>Dönüştürmeler ({conversions.length})</h2>
        <div className="list-actions">
          <button
            className="primary"
            type="button"
            disabled={done.length === 0 || zipping}
            onClick={downloadAllZip}
          >
            {zipping ? "Hazırlanıyor…" : `Tümünü indir (.zip · ${done.length})`}
          </button>
          <button className="ghost" type="button" onClick={() => onChange()}>
            Yenile
          </button>
        </div>
      </div>

      <ul className="conversions">
        {conversions.map((c) => (
          <li key={c.id} className={`conv ${c.status}`}>
            <div className="conv-row">
              <div className="conv-main">
                <span className={`badge ${c.status}`}>{c.status}</span>
                <span className="conv-name">{c.source_name}</span>
                {c.subject && <span className="muted small">— {c.subject}</span>}
              </div>
              <div className="conv-actions">
                {c.status === "done" && (
                  <>
                    <button
                      className="ghost"
                      type="button"
                      onClick={() =>
                        setOpenId(openId === c.id ? null : c.id)
                      }
                    >
                      {openId === c.id ? "Gizle" : "Önizle"}
                    </button>
                    <button
                      className="ghost"
                      type="button"
                      onClick={() =>
                        download(mdName(c.source_name), c.markdown ?? "")
                      }
                    >
                      İndir
                    </button>
                  </>
                )}
                <button
                  className="ghost danger"
                  type="button"
                  onClick={() => remove(c)}
                >
                  Sil
                </button>
              </div>
            </div>
            {c.status === "error" && c.error && (
              <p className="notice err small">{c.error}</p>
            )}
            {openId === c.id && c.markdown && (
              <pre className="preview">{c.markdown}</pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
