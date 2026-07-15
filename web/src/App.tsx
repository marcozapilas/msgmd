import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase.ts";
import type { Conversion } from "./lib/types.ts";
import { useToasts } from "./lib/useToasts.ts";
import { Auth } from "./components/Auth.tsx";
import { Uploader } from "./components/Uploader.tsx";
import { Library } from "./components/Library.tsx";
import { SopPrep } from "./components/SopPrep.tsx";
import { ProfileModal } from "./components/ProfileModal.tsx";
import { Toasts } from "./components/Toasts.tsx";
import {
  IconLayers,
  IconMark,
  IconMoon,
  IconSpinner,
  IconSun,
  IconUpload,
} from "./components/icons.tsx";
import { useTheme } from "./lib/useTheme.ts";

type View = "convert" | "library" | "sop";

/** Explicit Library load lifecycle (M1.1). Selection pruning is allowed only
 * in the transition to "complete"; "error"/"loading" must never prune. */
export type LibraryLoadState = "idle" | "loading" | "complete" | "error";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const [view, setView] = useState<View>("convert");
  const [profileOpen, setProfileOpen] = useState(false);
  // Evidence selection lives here (not in Library) so it survives view
  // switches (Library <-> SOP stub). In-memory only: cleared on sign-out and
  // naturally on page refresh; never persisted to DB or localStorage.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loadState, setLoadState] = useState<LibraryLoadState>("idle");
  // Run-id guard: only the newest refresh may write conversions/loadState,
  // so a stale in-flight refresh can never overwrite the latest state.
  const refreshRun = useRef(0);
  const { toasts, push, dismiss } = useToasts();
  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingSession(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Sign-out clears the selection and leaves selection mode.
  useEffect(() => {
    if (!session) {
      setSelectedIds(new Set());
      setSelectMode(false);
      setView("convert");
      setLoadState("idle");
      refreshRun.current += 1; // invalidate any in-flight refresh
    }
  }, [session]);

  /** Intersect the selection with the FULL successfully loaded dataset.
   * Called only on the transition to "complete" — never on partial pages,
   * errors, or any filter/pagination event. */
  const reconcileSelectedIds = useCallback((loaded: Conversion[]) => {
    const loadedIds = new Set(loaded.map((c) => c.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (loadedIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  /** Immediately drop only IDs confirmed deleted by a successful delete. */
  const removeFromSelection = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) if (next.delete(id)) changed = true;
      return changed ? next : prev;
    });
  }, []);

  const toggleId = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectMany = useCallback((ids: string[], selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (selected) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const refresh = useCallback(async () => {
    // Metadata only — never pull the (potentially huge) markdown column for the
    // whole library. Markdown is fetched on demand (preview/download/search).
    // Page through in 1000-row ranges so every row loads regardless of the
    // server's per-request cap.
    const run = ++refreshRun.current;
    setLoadState("loading");
    const cols =
      "id,user_id,batch_id,source_name,subject,status,error,size_bytes,created_at,output_path,storage_path,sender_name,sender_email,sent_at";
    const PAGE = 1000;
    const all: Conversion[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("conversions")
        .select(cols)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE - 1);
      if (run !== refreshRun.current) return; // stale run: a newer refresh owns state
      if (error || !data) {
        // Partial/failed load: keep whatever rendered, NEVER prune selection.
        setLoadState("error");
        return;
      }
      all.push(...(data as Conversion[]));
      // Progressive render: show each page as it arrives so the first 1000 rows
      // appear almost immediately instead of waiting for the whole library.
      setConversions([...all]);
      if (data.length < PAGE) break;
    }
    if (run !== refreshRun.current) return;
    // Full successful load only: now the dataset is authoritative.
    reconcileSelectedIds(all);
    setLoadState("complete");
  }, [reconcileSelectedIds]);

  useEffect(() => {
    if (session) void refresh();
    else setConversions([]);
  }, [session, refresh]);

  if (loadingSession) {
    return (
      <div className="center-load">
        <IconSpinner size={26} />
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="auth-page">
        <div className="auth-wrap">
          <Auth onToast={push} />
        </div>
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  const user = session.user;
  const displayName =
    (user.user_metadata?.display_name as string | undefined) ||
    user.email?.split("@")[0] ||
    "there";
  const initial = (displayName[0] || "?").toUpperCase();

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-brand">
          <span className="brand-mark">
            <IconMark size={19} />
          </span>
          <span className="rail-word">msgmd</span>
        </div>

        <nav className="rail-nav">
          <button
            className={`rail-item ${view === "convert" ? "active" : ""}`}
            onClick={() => setView("convert")}
          >
            <IconUpload size={19} />
            <span>Convert</span>
          </button>
          <button
            className={`rail-item ${view === "library" ? "active" : ""}`}
            onClick={() => setView("library")}
          >
            <IconLayers size={19} />
            <span>Library</span>
            {conversions.length > 0 && (
              <span className="rail-badge">{conversions.length}</span>
            )}
          </button>
        </nav>

        <button
          className="rail-item theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <IconSun size={19} /> : <IconMoon size={19} />}
          <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>

        <button className="rail-profile" onClick={() => setProfileOpen(true)}>
          <span className="avatar">{initial}</span>
          <span className="rail-profile-text">
            <span className="rail-profile-name">{displayName}</span>
            <span className="rail-profile-sub">View profile</span>
          </span>
        </button>
      </aside>

      <main className="main">
        {view === "convert" ? (
          <div className="view">
            <header className="view-head">
              <h1 className="view-title">
                Good to see you, {displayName.split(" ")[0]}.
              </h1>
              <p className="view-sub">
                Turn Outlook .msg files into beautiful Markdown — privately, in
                your browser.
              </p>
            </header>
            <Uploader
              userId={user.id}
              onDone={refresh}
              onToast={push}
              onConverted={() => setView("library")}
            />
          </div>
        ) : view === "library" ? (
          <div className="view">
            <header className="view-head">
              <h1 className="view-title">Library</h1>
              <p className="view-sub">
                Every conversion, searchable down to the words inside.
              </p>
            </header>
            <Library
              conversions={conversions}
              onChange={refresh}
              onToast={push}
              onGoConvert={() => setView("convert")}
              selectMode={selectMode}
              selectedIds={selectedIds}
              loadState={loadState}
              onEnterSelectMode={() => setSelectMode(true)}
              onExitSelectMode={exitSelectMode}
              onToggleId={toggleId}
              onSelectMany={selectMany}
              onClearSelection={clearSelection}
              onCreateSop={() => setView("sop")}
              onDeleted={removeFromSelection}
              onRetryLoad={() => void refresh()}
            />
          </div>
        ) : (
          <SopPrep
            sources={conversions.filter((c) => selectedIds.has(c.id))}
            selectedCount={selectedIds.size}
            loadState={loadState}
            onRetry={() => void refresh()}
            onBack={() => setView("library")}
          />
        )}
      </main>

      {profileOpen && (
        <ProfileModal
          user={user}
          totalConversions={conversions.length}
          onClose={() => setProfileOpen(false)}
          onToast={push}
        />
      )}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
