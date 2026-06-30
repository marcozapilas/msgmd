import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import JSZip from "jszip";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { supabase } from "../lib/supabase.ts";
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
  IconSparkle,
  IconSpinner,
  IconTrash,
  IconUpload,
  IconX,
} from "./icons.tsx";

interface Props {
  conversions: Conversion[];
  onChange: () => void | Promise<void>;
  onToast: (kind: "ok" | "err" | "info", text: string) => void;
  onGoConvert: () => void;
}

type Filter = "all" | "done" | "pending" | "error";

const STATUS_LABEL: Record<Conversion["status"], string> = {
  done: "Done",
  pending: "Processing",
  error: "Failed",
};
const PAGE_SIZES = [10, 25, 50];
const CONTENT_MATCH_LIMIT = 50;

const mdName = (s: string) => s.replace(/\.msg$/i, "") + ".md";

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
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
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
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string);
}

/** Fetch the markdown column for a set of ids, chunked to keep URLs short. */
async function fetchMarkdownMap(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data } = await supabase
      .from("conversions")
      .select("id,markdown")
      .in("id", chunk);
    for (const r of data ?? [])
      out.set(r.id as string, (r.markdown as string) ?? "");
  }
  return out;
}

async function zipItems(
  items: { source_name: string; markdown: string }[],
  filename: string,
) {
  const zip = new JSZip();
  const used = new Map<string, number>();
  for (const it of items) {
    const base = mdName(it.source_name);
    const seen = used.get(base) ?? 0;
    const name = seen > 0 ? base.replace(/\.md$/, `-${seen}.md`) : base;
    used.set(base, seen + 1);
    zip.file(name, it.markdown);
  }
  saveBlob(filename, await zip.generateAsync({ type: "blob" }));
}

function Highlight({ text, q }: { text: string; q: string }): ReactNode {
  if (!q) return text;
  const lower = text.toLocaleLowerCase("en");
  const ql = q.toLocaleLowerCase("en");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const idx = lower.indexOf(ql, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={key++}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
  }
  return out;
}

function contentSnippet(md: string, q: string): string | null {
  const idx = md.toLocaleLowerCase("en").indexOf(q.toLocaleLowerCase("en"));
  if (idx === -1) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(md.length, idx + q.length + 90);
  let s = md.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "… " + s;
  if (end < md.length) s = s + " …";
  return s;
}

interface Group {
  key: string;
  items: Conversion[];
  latest: string;
}

export function Library({ conversions, onChange, onToast, onGoConvert }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [preview, setPreview] = useState<Conversion | null>(null);
  const [previewMd, setPreviewMd] = useState<string | null>(null);
  const [rendered, setRendered] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [paging, setPaging] = useState<
    Record<string, { page: number; size: number }>
  >({});
  const [busy, setBusy] = useState(false);
  // Markdown fetched on demand, cached by id.
  const [mdCache, setMdCache] = useState<Record<string, string>>({});
  // ids whose body matched the current search (null = no content search).
  const [contentIds, setContentIds] = useState<Set<string> | null>(null);
  const cacheRef = useRef<Record<string, string>>({});
  cacheRef.current = mdCache;

  const getPaging = (k: string) => paging[k] ?? { page: 1, size: 10 };
  const setPageSize = (k: string, size: number) =>
    setPaging((p) => ({ ...p, [k]: { page: 1, size } }));
  const setPage = (k: string, page: number) =>
    setPaging((p) => ({ ...p, [k]: { ...getPaging(k), page } }));

  const q = query.trim();
  const ql = q.toLocaleLowerCase("en");

  async function getMarkdown(id: string): Promise<string> {
    if (cacheRef.current[id] != null) return cacheRef.current[id];
    const { data } = await supabase
      .from("conversions")
      .select("markdown")
      .eq("id", id)
      .single();
    const md = (data?.markdown as string) ?? "";
    setMdCache((prev) => ({ ...prev, [id]: md }));
    return md;
  }

  // Content (full-text) search runs on the server so we never load every body.
  useEffect(() => {
    if (q.length < 2) {
      setContentIds(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("conversions")
        .select("id,markdown")
        .ilike("markdown", `%${q}%`)
        .limit(CONTENT_MATCH_LIMIT);
      if (cancelled) return;
      const ids = new Set<string>();
      const add: Record<string, string> = {};
      for (const r of data ?? []) {
        ids.add(r.id as string);
        if (r.markdown) add[r.id as string] = r.markdown as string;
      }
      setContentIds(ids);
      if (Object.keys(add).length) setMdCache((prev) => ({ ...prev, ...add }));
    }, 320);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPreview(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  const stats = useMemo(() => {
    const weekAgo = Date.now() - 7 * 864e5;
    let week = 0;
    let done = 0;
    for (const c of conversions) {
      if (c.status === "done") done += 1;
      if (new Date(c.created_at).getTime() >= weekAgo) week += 1;
    }
    return { total: conversions.length, week, done };
  }, [conversions]);

  const counts = useMemo(() => {
    const c = { all: conversions.length, done: 0, pending: 0, error: 0 };
    for (const x of conversions) c[x.status] += 1;
    return c;
  }, [conversions]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Conversion[]>();
    for (const c of conversions) {
      if (filter !== "all" && c.status !== filter) continue;
      if (ql) {
        const inMeta =
          c.source_name.toLocaleLowerCase("en").includes(ql) ||
          (c.subject ?? "").toLocaleLowerCase("en").includes(ql);
        const inBody = contentIds?.has(c.id) ?? false;
        if (!inMeta && !inBody) continue;
      }
      const key = c.batch_id ?? "legacy";
      const arr = map.get(key);
      if (arr) arr.push(c);
      else map.set(key, [c]);
    }
    const result: Group[] = [];
    for (const [key, items] of map) {
      const latest = items.reduce(
        (mx, it) => (it.created_at > mx ? it.created_at : mx),
        items[0].created_at,
      );
      result.push({ key, items, latest });
    }
    result.sort((a, b) => (a.latest < b.latest ? 1 : -1));
    return result;
  }, [conversions, filter, ql, contentIds]);

  const allDone = useMemo(
    () => conversions.filter((c) => c.status === "done"),
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

  async function withBusy<T>(fn: () => Promise<T>) {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }

  async function exportAll() {
    if (allDone.length === 0) return;
    await withBusy(async () => {
      const map = await fetchMarkdownMap(allDone.map((c) => c.id));
      await zipItems(
        allDone.map((c) => ({
          source_name: c.source_name,
          markdown: map.get(c.id) ?? "",
        })),
        "msgmd-all.zip",
      );
      onToast("ok", `Exported ${allDone.length} file(s)`);
    });
  }

  async function downloadBatch(g: Group) {
    const done = g.items.filter((c) => c.status === "done");
    if (done.length === 0) return onToast("info", "Nothing converted yet");
    await withBusy(async () => {
      const map = await fetchMarkdownMap(done.map((c) => c.id));
      await zipItems(
        done.map((c) => ({
          source_name: c.source_name,
          markdown: map.get(c.id) ?? "",
        })),
        "msgmd-batch.zip",
      );
      onToast("ok", `Downloaded ${done.length} file(s)`);
    });
  }

  async function mergeBatch(g: Group) {
    const done = g.items.filter((c) => c.status === "done");
    if (done.length === 0) return onToast("info", "Nothing converted yet");
    await withBusy(async () => {
      const map = await fetchMarkdownMap(done.map((c) => c.id));
      const merged = done
        .map((c) => map.get(c.id) ?? "")
        .join("\n\n---\n\n");
      downloadText("msgmd-merged.md", merged);
      onToast("ok", `Merged ${done.length} file(s)`);
    });
  }

  async function downloadOne(c: Conversion) {
    const md = await getMarkdown(c.id);
    downloadText(mdName(c.source_name), md);
  }

  async function copyMarkdown(c: Conversion) {
    try {
      await navigator.clipboard.writeText(await getMarkdown(c.id));
      onToast("ok", "Copied to clipboard");
    } catch {
      onToast("err", "Copy failed");
    }
  }

  async function openPreview(c: Conversion) {
    setPreview(c);
    setPreviewMd(cacheRef.current[c.id] ?? null);
    if (cacheRef.current[c.id] == null) {
      const md = await getMarkdown(c.id);
      setPreviewMd(md);
    }
  }

  async function remove(c: Conversion) {
    const { error } = await supabase.from("conversions").delete().eq("id", c.id);
    if (error) return onToast("err", "Delete failed: " + error.message);
    if (preview?.id === c.id) setPreview(null);
    await onChange();
  }

  async function deleteBatch(g: Group) {
    await withBusy(async () => {
      const ids = g.items.map((c) => c.id);
      for (let i = 0; i < ids.length; i += 100) {
        const { error } = await supabase
          .from("conversions")
          .delete()
          .in("id", ids.slice(i, i + 100));
        if (error) {
          onToast("err", "Delete failed: " + error.message);
          break;
        }
      }
      onToast("ok", "Batch deleted");
      await onChange();
    });
  }

  if (conversions.length === 0) {
    return (
      <section className="card pad">
        <div className="empty">
          <div className="e-ic">
            <IconInbox size={24} />
          </div>
          <p>Your library is empty.</p>
          <p className="small muted">Convert your first .msg to see it here.</p>
          <button
            className="btn-primary"
            style={{ marginTop: 14 }}
            onClick={onGoConvert}
          >
            <IconUpload size={16} /> Convert files
          </button>
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
    <>
      <div className="stat-cards">
        <div className="stat-card">
          <span className="stat-ic">
            <IconLayers size={18} />
          </span>
          <div>
            <div className="stat-num">{stats.total}</div>
            <div className="stat-lbl">Total conversions</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-ic">
            <IconSparkle size={18} />
          </span>
          <div>
            <div className="stat-num">{stats.week}</div>
            <div className="stat-lbl">This week</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-ic">
            <IconArchive size={18} />
          </span>
          <div>
            <div className="stat-num">{stats.done}</div>
            <div className="stat-lbl">Ready to export</div>
          </div>
        </div>
      </div>

      <section className="card pad">
        <div className="search big">
          <IconSearch size={18} />
          <input
            type="text"
            placeholder="Search names, subjects, and the words inside…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className="icon-btn"
              onClick={() => setQuery("")}
              aria-label="Clear"
            >
              <IconX size={15} />
            </button>
          )}
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
          <button
            className="btn-primary btn-sm export-btn"
            type="button"
            disabled={allDone.length === 0 || busy}
            onClick={exportAll}
          >
            <IconArchive size={15} />
            {busy ? "Working…" : `Export all (${allDone.length})`}
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

        {q.length >= 2 && contentIds === null && (
          <p className="empty small">Searching inside content…</p>
        )}

        {groups.length === 0 ? (
          <p className="empty small">No results match your search.</p>
        ) : (
          <div className="batches">
            {groups.map((group, idx) => {
              const isOpen = !collapsed.has(group.key);
              const done = group.items.filter((c) => c.status === "done").length;
              const failed = group.items.filter(
                (c) => c.status === "error",
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
                          <span className="batch-count">
                            {group.items.length}
                          </span>
                        </div>
                        <div className="batch-meta">
                          {fmtRelative(group.latest)} · {done} done
                          {failed > 0 && ` · ${failed} failed`}
                        </div>
                      </div>
                    </div>
                    <div className="batch-actions">
                      <button
                        className="icon-btn"
                        type="button"
                        disabled={busy}
                        title="Download batch (.zip)"
                        aria-label="Download batch"
                        onClick={() => downloadBatch(group)}
                      >
                        <IconArchive size={16} />
                      </button>
                      <button
                        className="icon-btn"
                        type="button"
                        disabled={busy}
                        title="Merge into one .md"
                        aria-label="Merge"
                        onClick={() => mergeBatch(group)}
                      >
                        <IconMerge size={16} />
                      </button>
                      <button
                        className="icon-btn danger"
                        type="button"
                        disabled={busy}
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
                        {pageItems.map((c) => {
                          const inMeta =
                            !!ql &&
                            (c.source_name.toLocaleLowerCase("en").includes(ql) ||
                              (c.subject ?? "")
                                .toLocaleLowerCase("en")
                                .includes(ql));
                          const snip =
                            ql && !inMeta && cacheRef.current[c.id]
                              ? contentSnippet(cacheRef.current[c.id], q)
                              : null;
                          return (
                            <li key={c.id} className="row">
                              <span className={`chip ${c.status}`}>
                                <span className="cdot" />
                                {STATUS_LABEL[c.status]}
                              </span>
                              <div className="row-main">
                                <div className="row-name">
                                  <Highlight text={c.source_name} q={q} />
                                </div>
                                {c.subject && (
                                  <div className="row-sub">
                                    <Highlight text={c.subject} q={q} />
                                  </div>
                                )}
                                {snip && (
                                  <div className="row-snippet">
                                    <Highlight text={snip} q={q} />
                                  </div>
                                )}
                                <div className="row-meta">
                                  <span>{fmtDateTime(c.created_at)}</span>
                                  {fmtSize(c.size_bytes) && (
                                    <span>{fmtSize(c.size_bytes)}</span>
                                  )}
                                </div>
                                {c.status === "error" && c.error && (
                                  <p className="notice err small row-err">
                                    {c.error}
                                  </p>
                                )}
                              </div>
                              <div className="row-actions">
                                {c.status === "done" && (
                                  <>
                                    <button
                                      className="icon-btn"
                                      type="button"
                                      onClick={() => openPreview(c)}
                                      title="Preview"
                                      aria-label="Preview"
                                    >
                                      <IconEye size={17} />
                                    </button>
                                    <button
                                      className="icon-btn"
                                      type="button"
                                      onClick={() => downloadOne(c)}
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
                          );
                        })}
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
      </section>

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
                    disabled={previewMd == null}
                    onClick={() => preview && copyMarkdown(preview)}
                  >
                    <IconCopy size={15} /> Copy
                  </button>
                  <button
                    className="btn-subtle btn-sm"
                    type="button"
                    disabled={previewMd == null}
                    onClick={() => preview && downloadOne(preview)}
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
                {previewMd == null ? (
                  <div className="modal-loading">
                    <IconSpinner size={22} />
                    <span>Loading…</span>
                  </div>
                ) : rendered ? (
                  <div
                    className="md-rendered"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdown(previewMd),
                    }}
                  />
                ) : (
                  <pre className="preview">{previewMd}</pre>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
