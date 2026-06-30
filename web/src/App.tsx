import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase.ts";
import type { Conversion } from "./lib/types.ts";
import { useToasts } from "./lib/useToasts.ts";
import { Auth } from "./components/Auth.tsx";
import { Uploader } from "./components/Uploader.tsx";
import { Library } from "./components/Library.tsx";
import { ProfileModal } from "./components/ProfileModal.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { IconLayers, IconSpinner, IconUpload } from "./components/icons.tsx";

type View = "convert" | "library";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const [view, setView] = useState<View>("convert");
  const [profileOpen, setProfileOpen] = useState(false);
  const { toasts, push, dismiss } = useToasts();

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

  const refresh = useCallback(async () => {
    // Metadata only — never pull the (potentially huge) markdown column for the
    // whole library. Markdown is fetched on demand (preview/download/search).
    // Page through in 1000-row ranges so every row loads regardless of the
    // server's per-request cap.
    const cols =
      "id,user_id,batch_id,source_name,subject,status,error,size_bytes,created_at,output_path,storage_path";
    const PAGE = 1000;
    const all: Conversion[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("conversions")
        .select(cols)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error || !data) break;
      all.push(...(data as Conversion[]));
      // Progressive render: show each page as it arrives so the first 1000 rows
      // appear almost immediately instead of waiting for the whole library.
      setConversions([...all]);
      if (data.length < PAGE) break;
    }
  }, []);

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
          <span className="mark">✦</span>
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
        ) : (
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
            />
          </div>
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
