import type { Toast } from "../lib/useToasts.ts";
import { IconAlert, IconCheck, IconMail, IconX } from "./icons.tsx";

interface Props {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function Toasts({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="t-ic">
            {t.kind === "ok" ? (
              <IconCheck size={15} />
            ) : t.kind === "err" ? (
              <IconAlert size={15} />
            ) : (
              <IconMail size={15} />
            )}
          </span>
          <span style={{ flex: 1 }}>{t.text}</span>
          <button
            className="icon-btn"
            onClick={() => onDismiss(t.id)}
            aria-label="Kapat"
          >
            <IconX size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
