import { useState } from "react";
import { supabase } from "../lib/supabase.ts";
import { IconSpinner } from "./icons.tsx";

type Mode = "signin" | "signup" | "magic";

interface Props {
  onToast: (kind: "ok" | "err" | "info", text: string) => void;
}

export function Auth({ onToast }: Props) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (mode === "magic") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        setMessage("Giriş bağlantısı e-postana gönderildi.");
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage("Kayıt oluşturuldu. Gerekirse e-postandaki bağlantıyı onayla.");
        onToast("ok", "Hesap oluşturuldu");
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card auth">
      <div className="eyebrow">msgmd</div>
      <h2>Tekrar hoş geldin</h2>
      <p className="sub">.msg arşivini saniyeler içinde temiz Markdown'a çevir.</p>

      <div className="tabs">
        <button
          className={mode === "signin" ? "active" : ""}
          onClick={() => setMode("signin")}
          type="button"
        >
          Parola
        </button>
        <button
          className={mode === "magic" ? "active" : ""}
          onClick={() => setMode("magic")}
          type="button"
        >
          E-posta linki
        </button>
        <button
          className={mode === "signup" ? "active" : ""}
          onClick={() => setMode("signup")}
          type="button"
        >
          Kayıt ol
        </button>
      </div>

      <form onSubmit={submit}>
        <label>
          E-posta
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
            placeholder="ornek@sirket.com"
          />
        </label>
        {mode !== "magic" && (
          <label>
            Parola
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              placeholder="••••••••"
            />
          </label>
        )}
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy && <IconSpinner size={16} />}
          {busy
            ? "Gönderiliyor…"
            : mode === "magic"
              ? "Bağlantı gönder"
              : mode === "signup"
                ? "Hesap oluştur"
                : "Giriş yap"}
        </button>
      </form>

      {message && <p className="notice ok">{message}</p>}
      {error && <p className="notice err">{error}</p>}
    </section>
  );
}
