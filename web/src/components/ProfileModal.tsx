import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase.ts";
import { IconLogout, IconUser, IconX } from "./icons.tsx";

interface Props {
  user: User;
  totalConversions: number;
  onClose: () => void;
  onToast: (kind: "ok" | "err" | "info", text: string) => void;
}

function memberSince(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

export function ProfileModal({ user, totalConversions, onClose, onToast }: Props) {
  const initialName = (user.user_metadata?.display_name as string) || "";
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    setSaving(true);
    try {
      const { error } = await supabase.auth.updateUser({
        data: { display_name: name.trim() },
      });
      if (error) throw error;
      onToast("ok", "Profile updated");
      onClose();
    } catch (e) {
      onToast("err", e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const initial = (name || user.email || "?")[0].toUpperCase();

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div
        className="modal profile-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>
            <IconUser size={17} /> Profile
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX size={17} />
          </button>
        </div>
        <div className="modal-body">
          <div className="profile-hero">
            <span className="avatar lg">{initial}</span>
            <div>
              <div className="profile-email">{user.email}</div>
              <div className="muted small">
                Member since {memberSince(user.created_at)}
              </div>
            </div>
          </div>

          <div className="profile-stats">
            <div className="pstat">
              <div className="pstat-n">{totalConversions}</div>
              <div className="pstat-l">Conversions</div>
            </div>
            <div className="pstat">
              <div className="pstat-n">∞</div>
              <div className="pstat-l">Privacy (local)</div>
            </div>
          </div>

          <label className="profile-field">
            Display name
            <input
              type="text"
              value={name}
              maxLength={40}
              placeholder="Your name"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="profile-actions">
            <button
              className="btn-ghost"
              type="button"
              onClick={() => supabase.auth.signOut()}
            >
              <IconLogout size={16} /> Sign out
            </button>
            <button
              className="btn-primary"
              type="button"
              disabled={saving || name.trim() === initialName.trim()}
              onClick={save}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
