import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import JSZip from "jszip";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { MD_BUCKET, MSG_BUCKET, supabase } from "../lib/supabase.ts";
import type { Conversion } from "../lib/types.ts";
import {
  IconArchive,
  IconChevron,
  IconCopy,
  IconDownload,
  IconEye,
  IconInbox,
  IconLayers,
  IconMerge,
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

type Filter = "all" | "done" | "pending" | "error";

const STATUS_LABEL: Record<Conversion["status"], string> = {
  done: "Done",
  pending: "Processing",
  error: "Failed",
};

function mdName(sourceName: string): string {
  return sourceName.replace(/\.msg$/i, "") + ".md";
}

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function fmtSize(n: number | null): string | null {
  if (!n && n !== 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadText(filename: string, content: string) {
  saveBlob(filename, new Blob([content], { type: "text/markdown;charset=utf-8" }));
}

function renderMarkdown(md: string): string {
  const html = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(html);
}

async function zipConversions(list: Conversion[], filename: string) {
  const zip = new JSZip();
  const used = new Map<string, number>();
  for (const c of list) {
    if (!c.markdown) continue;
    const base = mdName(c.source_name);
    const seen = used.get(base) ?? 0;
    const name = seen > 0 ? base.replace(/\.md$/, `-${seen}.md`) : base;
    used.set(base, seen + 1);
    zip.file(name, c.markdown);
  }
  saveBlob(filename, await zip.generateAsync({ type: "blob" }));
}

interface Group {
  key: string;
  items: Conversion[];
  latest: string;
}

export function ConversionList({ conversions, onChange, onToast }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [preview, setPreview] = useState<Conversion | null>(null);
  const [rendered, setRendered] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [paging, setPaging] = useState<Record<string, { page: number; size: number }>>(
    {},
  );
  const [zipping, setZipping] = useState(false);

  const PAGE_SIZES = [10, 25, 50];
  const getPaging = (key: string) => paging[key] ?? { page: 1, size: 10 };
  const setPageSize = (key: string, size: number) =>
    setPaging((p) => ({ ...p, [key]: { page: 1, size } }));
  const setPage = (key: string, page: number) =>
    setPaging((p) => ({ ...p, [key]: { ...getPaging(key), page } }));

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreview(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const counts = useMemo(() => {
    const c = { all: conversions.length, done: 0, pending: 0, error: 0 };
    for (const x of conversions) c[x.status] += 1;
    return c;
  }, [conversions]);

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLocaleLowerCase("en");
    const map = new Map<string, Conversion[]>();
    for (const c of conversions) {
      if (filter !== "all" && c.status !== filter) continue;
      if (
        q &&
        !c.source_name.toLocaleLowerCase("en").includes(q) &&
        !(c.subject ?? "").toLocaleLowerCase("en").includes(q)
      )
        continue;
      const key = c.batch_id ?? "legacy";
      const arr = map.get(key);
      if (arr) arr.push(c);
      else map.set(key, [c]);
    }
    const result: Group[] = [];
    for (const [key, items] of map) {
      const latest = items.reduce(
        (max, it) => (it.created_at > max ? it.created_at : max),
        items[0].created_at,
      );
      result.push({ key, items, latest });
    }
    result.sort((a, b) => (a.latest < b.latest ? 1 : -1));
    return result;
  }, [conversions, filter, query]);

  const allDone = useMemo(
    () => conversions.filter((c) => c.status === "done" && c.markdown),
    [conversions],
  );

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function exportAll() {
    if (allDone.length === 0) return;
    setZipping(true);
    try {
      await zipConversions(allDone, "msgmd-all.zip");
      onToast("ok", `Exported ${allDone.length} file(s)`);
    } finally {
      setZipping(false);
    }
  }

  async function downloadBatch(group: Group) {
    const done = group.items.filter((c) => c.status === "done" && c.markdown);
    if (done.length === 0) {
      onToast("info", "Nothing converted in this batch yet");
      return;
    }
    await zipConversions(done, `msgmd-batch-${fmtRelative(group.latest)}.zip`);
    onToast("ok", `Downloaded ${done.length} file(s)`);
  }

  function mergeBatch(group: Group) {
    const done = group.items.filter((c) => c.status === "done" && c.markdown);
    if (done.length === 0) {
      onToast("info", "Nothing converted in this batch yet");
      return;
    }
    const merged = done
      .map((c) => c.markdown)
      .join("\n\n---\n\n");
    downloadText("msgmd-merged.md", merged);
    onToast("ok", `Merged ${done.length} file(s) into one .md`);
  }

  async function copyMarkdown(c: Conversion) {
    try {
      await navigator.clipboard.writeText(c.markdown ?? "");
      onToast("ok", "Copied to clipboard");
    } catch {
      onToast("err", "Copy failed");
    }
  }

  async function remove(c: Conversion) {
    if (c.storage_path) await supabase.storage.from(MSG_BUCKET).remove([c.storage_path]);
    if (c.output_path) await supabase.storage.from(MD_BUCKET).remove([c.output_path]);
    const { error } = await supabase.from("conversions").delete().eq("id", c.id);
    if (error) {
      onToast("err", "Delete failed: " + error.message);
      return;
    }
    if (preview?.id === c.id) setPreview(null);
    await onChange();
  }

  async function deleteBatch(group: Group) {
    const msgPaths = group.items
      .map((c) => c.storage_path)
      .filter((p): p is string => Boolean(p));
    const mdPaths = group.items
      .map((c) => c.output_path)
      .filter((p): p is string => Boolean(p));
    if (msgPaths.length) await supabase.storage.from(MSG_BUCKET).remove(msgPaths);
    if (mdPaths.length) await supabase.storage.from(MD_BUCKET).remove(mdPaths);
    const { error } = await supabase
      .from("conversions")
      .delete()
      .in(
        "id",
        group.items.map((c) => c.id),
      );
    if (error) onToast("err", "Delete failed: " + error.message);
    else onToast("ok", "Batch deleted");
    await onChange();
  }

  if (conversions.length === 0) {
    return (
      <section className="card pad">
        <div className="empty">
          <div className="e-ic">
            <IconInbox size={24} />
          </div>
          <p>No conversions yet.</p>
          <p className="small muted">Upload .msg files above to get started.</p>
        </div>
      </section>
    );
  }

  const filters: { key: Filter; label: string; n: number }[] = [
    { key: "all", label: "All", n: counts.all },
    { key: "done", label: "Done", n: counts.done },
    { key: "pending", label: "Processing", n: counts.pending },
    { key: "error", label: "Failed", n: counts.error },
  ];

  return (
    <section className="card pad">
      <div className="section-head">
        <h2>
          History <span className="count-pill">{conversions.length}</span>
        </h2>
        <div className="head-actions">
          <button
            className="btn-primary btn-sm"
            type="button"
            disabled={allDone.length === 0 || zipping}
            onClick={exportAll}
          >
            <IconArchive size={15} />
            {zipping ? "Preparing…" : `Export all (${allDone.length})`}
          </button>
          <button
            className="icon-btn"
            type="button"
            onClick={() => onChange()}
            title="Refresh"
            aria-label="Refresh"
          >
            <IconRefresh size={17} />
          </button>
        </div>
      </div>

      <div className="filters">
        {filters.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`tab ${filter === f.key ? "active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label} <span className="tab-n">{f.n}</span>
          </button>
        ))}
        {conversions.length > 5 && (
          <div className="search inline">
            <IconSearch size={15} />
            <input
              type="text"
              placeholder="Search name or subject…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="empty small">No results match your filter.</p>
      ) : (
        <div className="batches">
          {groups.map((group, idx) => {
            const isOpen = !collapsed.has(group.key);
            const done = group.items.filter((c) => c.status === "done").length;
            const failed = group.items.filter((c) => c.status === "error").length;
            const pending = group.items.filter(
              (c) => c.status === "pending",
            ).length;
            const label =
              group.key === "legacy"
                ? "Earlier"
                : `Upload #${groups.length - idx}`;
            const pg = getPaging(group.key);
            const totalPages = Math.max(
              1,
              Math.ceil(group.items.length / pg.size),
            );
            const page = Math.min(pg.page, totalPages);
            const pageItems = group.items.slice(
              (page - 1) * pg.size,
              page * pg.size,
            );
            const showPager = group.items.length > PAGE_SIZES[0];
            return (
              <div className="batch" key={group.key}>
                <div className="batch-head">
                  <button
                    className={`chevron ${isOpen ? "open" : ""}`}
                    type="button"
                    onClick={() => toggle(group.key)}
                    aria-label="Toggle"
                  >
                    <IconChevron size={16} />
                  </button>
                  <div className="batch-title">
                    <span className="batch-ic">
                      <IconLayers size={15} />
                    </span>
                    <div>
                      <div className="batch-name">
                        {label}
                        <span className="batch-count">{group.items.length}</span>
                      </div>
                      <div className="batch-meta">
                        {fmtRelative(group.latest)} · {done} done
                        {pending > 0 && ` · ${pending} processing`}
                        {failed > 0 && ` · ${failed} failed`}
                      </div>
                    </div>
                  </div>
                  <div className="batch-actions">
                    <button
                      className="icon-btn"
                      type="button"
                      title="Download batch (.zip)"
                      aria-label="Download batch"
                      onClick={() => downloadBatch(group)}
                    >
                      <IconArchive size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      type="button"
                      title="Merge into one .md"
                      aria-label="Merge"
                      onClick={() => mergeBatch(group)}
                    >
                      <IconMerge size={16} />
                    </button>
                    <button
                      className="icon-btn danger"
                      type="button"
                      title="Delete batch"
                      aria-label="Delete batch"
                      onClick={() => deleteBatch(group)}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div className="batch-body">
                    {showPager && (
                      <div className="pager-top">
                        <label className="pager-size">
                          Show
                          <select
                            value={pg.size}
                            onChange={(e) =>
                              setPageSize(group.key, Number(e.target.value))
                            }
                          >
                            {PAGE_SIZES.map((s) => (
                              <option key={s} value={s}>
                                {s}
                              </option>
                            ))}
                          </select>
                          per page
                        </label>
                        <span className="pager-info">
                          {(page - 1) * pg.size + 1}–
                          {Math.min(page * pg.size, group.items.length)} of{" "}
                          {group.items.length}
                        </span>
                      </div>
                    )}
                    <ul className="rows">
                      {pageItems.map((c) => (
                      <li key={c.id} className="row">
                        <span className={`chip ${c.status}`}>
                          <span className="cdot" />
                          {STATUS_LABEL[c.status]}
                        </span>
                        <div className="row-main">
                          <div className="row-name">{c.source_name}</div>
                          {c.subject && <div className="row-sub">{c.subject}</div>}
                          <div className="row-meta">
                            <span>{fmtDateTime(c.created_at)}</span>
                            {fmtSize(c.size_bytes) && (
                              <span>{fmtSize(c.size_bytes)}</span>
                            )}
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
                                title="Preview"
                                aria-label="Preview"
                              >
                                <IconEye size={17} />
                              </button>
                              <button
                                className="icon-btn"
                                type="button"
                                onClick={() =>
                                  downloadText(
                                    mdName(c.source_name),
                                    c.markdown ?? "",
                                  )
                                }
                                title="Download"
                                aria-label="Download"
                              >
                                <IconDownload size={17} />
                              </button>
                            </>
                          )}
                          <button
                            className="icon-btn danger"
                            type="button"
                            onClick={() => remove(c)}
                            title="Delete"
                            aria-label="Delete"
                          >
                            <IconTrash size={17} />
                          </button>
                        </div>
                      </li>
                      ))}
                    </ul>
                    {totalPages > 1 && (
                      <div className="pager-nav">
                        <button
                          className="btn-subtle btn-sm"
                          type="button"
                          disabled={page <= 1}
                          onClick={() => setPage(group.key, page - 1)}
                        >
                          Prev
                        </button>
                        <span className="pager-info">
                          Page {page} / {totalPages}
                        </span>
                        <button
                          className="btn-subtle btn-sm"
                          type="button"
                          disabled={page >= totalPages}
                          onClick={() => setPage(group.key, page + 1)}
                        >
                          Next
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {preview &&
        createPortal(
          <div className="overlay" onClick={() => setPreview(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{preview.subject || preview.source_name}</h3>
              <div className="modal-actions">
                <div className="toggle">
                  <button
                    type="button"
                    className={rendered ? "active" : ""}
                    onClick={() => setRendered(true)}
                  >
                    Rendered
                  </button>
                  <button
                    type="button"
                    className={!rendered ? "active" : ""}
                    onClick={() => setRendered(false)}
                  >
                    Raw
                  </button>
                </div>
                <button
                  className="btn-subtle btn-sm"
                  type="button"
                  onClick={() => copyMarkdown(preview)}
                >
                  <IconCopy size={15} /> Copy
                </button>
                <button
                  className="btn-subtle btn-sm"
                  type="button"
                  onClick={() =>
                    downloadText(mdName(preview.source_name), preview.markdown ?? "")
                  }
                >
                  <IconDownload size={15} /> Download
                </button>
                <button
                  className="icon-btn"
                  type="button"
                  onClick={() => setPreview(null)}
                  aria-label="Close"
                >
                  <IconX size={17} />
                </button>
              </div>
            </div>
            <div className="modal-body">
              {rendered ? (
                <div
                  className="md-rendered"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(preview.markdown ?? ""),
                  }}
                />
              ) : (
                <pre className="preview">{preview.markdown}</pre>
              )}
            </div>
          </div>
          </div>,
          document.body,
        )}
    </section>
  );
}
