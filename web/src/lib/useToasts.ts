import { useCallback, useRef, useState } from "react";

export interface Toast {
  id: string;
  kind: "ok" | "err" | "info";
  text: string;
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current[id];
    if (timer) {
      clearTimeout(timer);
      delete timers.current[id];
    }
  }, []);

  const push = useCallback(
    (kind: Toast["kind"], text: string, ttl = 4200) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, kind, text }]);
      timers.current[id] = setTimeout(() => dismiss(id), ttl);
    },
    [dismiss],
  );

  return { toasts, push, dismiss };
}
