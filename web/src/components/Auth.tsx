import { useState } from "react";
import { supabase } from "../lib/supabase.ts";
import { IconCheck, IconMark, IconSpinner } from "./icons.tsx";

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
        setMessage("Check your inbox — we sent you a sign-in link.");
      } else if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage("Account created. Confirm via the email link if required.");
        onToast("ok", "Account created");
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
    <div className="auth-split">
      <aside className="auth-brand">
        <div className="brand-row">
          <span className="brand-mark">
            <IconMark size={18} />
          </span>
          msgmd
        </div>
        <h1>Outlook mail, reborn as clean Markdown.</h1>
        <ul className="auth-points">
          <li>
            <IconCheck size={15} />
            Converted locally in your browser — messages never leave your
            device
          </li>
          <li>
            <IconCheck size={15} />
            Batch uploads with per-batch export and merge
          </li>
          <li>
            <IconCheck size={15} />
            Full-text search across everything you convert
          </li>
        </ul>
      </aside>

      <section className="auth">
        <h2>Welcome back</h2>
        <p className="sub">Sign in to pick up right where you left off.</p>

        <div className="tabs">
          <button
            className={mode === "signin" ? "active" : ""}
            onClick={() => setMode("signin")}
            type="button"
          >
            Password
          </button>
          <button
            className={mode === "magic" ? "active" : ""}
            onClick={() => setMode("magic")}
            type="button"
          >
            Email link
          </button>
          <button
            className={mode === "signup" ? "active" : ""}
            onClick={() => setMode("signup")}
            type="button"
          >
            Sign up
          </button>
        </div>

        <form onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@company.com"
            />
          </label>
          {mode !== "magic" && (
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
                placeholder="••••••••"
              />
            </label>
          )}
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy && <IconSpinner size={16} />}
            {busy
              ? "Sending…"
              : mode === "magic"
                ? "Send magic link"
                : mode === "signup"
                  ? "Create account"
                  : "Sign in"}
          </button>
        </form>

        {message && <p className="notice ok">{message}</p>}
        {error && <p className="notice err">{error}</p>}
      </section>
    </div>
  );
}
