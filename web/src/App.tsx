import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase.ts";
import type { Conversion } from "./lib/types.ts";
import { useToasts } from "./lib/useToasts.ts";
import { Auth } from "./components/Auth.tsx";
import { Uploader } from "./components/Uploader.tsx";
import { ConversionList } from "./components/ConversionList.tsx";
import { Toasts } from "./components/Toasts.tsx";
import { IconLogout, IconSpinner } from "./components/icons.tsx";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingSession(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    const { data, error } = await supabase
      .from("conversions")
      .select("*")
      .order("created_at", { ascending: false });
    if (!error && data) {
      setConversions(data as Conversion[]);
    }
  }, []);

  useEffect(() => {
    if (session) {
      void refresh();
    } else {
      setConversions([]);
    }
  }, [session, refresh]);

  if (loadingSession) {
    return (
      <div className="center-load">
        <IconSpinner size={26} />
        <p className="muted">Yükleniyor…</p>
      </div>
    );
  }

  const initial = session?.user.email?.[0]?.toUpperCase() ?? "?";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark">✦</span>
          <div>
            <h1>msgmd</h1>
            <div className="tag">Outlook .msg → zarif Markdown</div>
          </div>
        </div>
        {session && (
          <div className="account">
            <span className="avatar">{initial}</span>
            <span className="email">{session.user.email}</span>
            <button
              className="btn-ghost btn-sm"
              onClick={() => supabase.auth.signOut()}
            >
              <IconLogout size={15} /> Çıkış
            </button>
          </div>
        )}
      </header>

      <main className="container">
        {!session ? (
          <div className="auth-wrap">
            <Auth onToast={push} />
          </div>
        ) : (
          <>
            <Uploader userId={session.user.id} onDone={refresh} onToast={push} />
            <ConversionList
              conversions={conversions}
              onChange={refresh}
              onToast={push}
            />
          </>
        )}
      </main>

      <footer className="footer">
        Dosyaların yalnızca senin hesabında saklanır · uçtan uca RLS korumalı
      </footer>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
