import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase.ts";
import type { Conversion } from "./lib/types.ts";
import { Auth } from "./components/Auth.tsx";
import { Uploader } from "./components/Uploader.tsx";
import { ConversionList } from "./components/ConversionList.tsx";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [conversions, setConversions] = useState<Conversion[]>([]);

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
      <main className="container">
        <p className="muted">Yükleniyor…</p>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">✉️→📝</span>
          <div>
            <h1>msgmd</h1>
            <p className="muted">Outlook .msg → temiz Markdown</p>
          </div>
        </div>
        {session && (
          <div className="account">
            <span className="muted">{session.user.email}</span>
            <button
              className="ghost"
              onClick={() => supabase.auth.signOut()}
            >
              Çıkış
            </button>
          </div>
        )}
      </header>

      <main className="container">
        {!session ? (
          <Auth />
        ) : (
          <>
            <Uploader userId={session.user.id} onDone={refresh} />
            <ConversionList conversions={conversions} onChange={refresh} />
          </>
        )}
      </main>

      <footer className="footer muted">
        Dosyalar yalnızca senin hesabında saklanır (RLS korumalı).
      </footer>
    </div>
  );
}
