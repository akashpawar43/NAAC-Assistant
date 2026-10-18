import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Column } from "../api";
import { Icon, type IconName } from "./Icon";

const STATUS_LABEL: Record<string, string> = { empty: "Not started", partial: "Partial", complete: "Complete" };

export function StatusChip({ status }: { status: string }) {
  return <span className={`status ${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function formatValue(v: number | null, unit?: string | null): string {
  if (v === null || v === undefined) return "–";
  const n = Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (!unit) return n;
  return unit === "%" ? `${n}%` : unit.startsWith(":") ? `${n} ${unit}` : `${n} ${unit}`;
}

const SEV_ICON: Record<"high" | "medium" | "low", IconName> = { high: "alertCircle", medium: "alert", low: "info" };

export function Severity({ s }: { s: "high" | "medium" | "low" }) {
  return (
    <span className={`sev ${s}`}>
      <Icon name={SEV_ICON[s]} size={13} />
      {s}
    </span>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? "tab on" : "tab"} onClick={() => onChange(t.id)}>
          {t.label}
          {t.count !== undefined && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A small set of mutually exclusive filters, shown as one control. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: ReactNode; count?: number }[];
  value: T | T[];
  onChange: (t: T) => void;
  label: string;
}) {
  const on = (id: T) => (Array.isArray(value) ? value.includes(id) : value === id);
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={on(o.id)} onClick={() => onChange(o.id)}>
          {o.label}
          {o.count !== undefined && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function ErrorList({ errors }: { errors: { row?: number; field?: string; message: string }[] }) {
  if (!errors.length) return null;
  return (
    <ul className="errors" role="alert">
      {errors.slice(0, 50).map((e, i) => (
        <li key={i}>
          {e.row ? `Row ${e.row}: ` : ""}
          {e.message}
        </li>
      ))}
      {errors.length > 50 && <li>…and {errors.length - 50} more</li>}
    </ul>
  );
}

export function cellText(v: unknown): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return v === null || v === undefined ? "" : String(v);
}

/** One input for a data-table column: dropdown for enums, Yes/No and years; text/number/date otherwise. */
export function FieldInput({ c, value, onChange, years }: { c: Column; value: string; onChange: (v: string) => void; years: string[] }) {
  const opts = c.type === "enum" ? c.options : c.type === "bool" ? ["Yes", "No"] : c.type === "year" ? years : undefined;
  if (opts)
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={c.label}>
        <option value="" />
        {opts.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  return (
    <input
      aria-label={c.label}
      value={value}
      type={c.type === "date" ? "date" : c.type === "int" || c.type === "number" ? "number" : "text"}
      step={c.type === "number" ? "any" : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ---------------------------------------------------------------- layout pieces

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  crumbs,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  crumbs?: ReactNode;
}) {
  return (
    <>
      {crumbs && (
        <nav className="crumbs" aria-label="Breadcrumb">
          {crumbs}
        </nav>
      )}
      <header className="page-header">
        <div className="heading">
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h1>{title}</h1>
          {description && <p className="desc">{description}</p>}
        </div>
        {actions && <div className="actions">{actions}</div>}
      </header>
    </>
  );
}

export function Notice({ kind = "info", children, icon }: { kind?: "info" | "warn" | "error" | "success"; children: ReactNode; icon?: IconName }) {
  const name = icon ?? ({ info: "info", warn: "alert", error: "alertCircle", success: "checkCircle" } as const)[kind];
  return (
    <div className={`notice ${kind === "info" ? "" : kind}`} role={kind === "error" ? "alert" : undefined}>
      <Icon name={name} />
      <div className="body">{children}</div>
    </div>
  );
}

export function EmptyState({ icon = "info", title, children, action }: { icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="icon">
        <Icon name={icon} size={18} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

/** Page placeholder while the first request runs: the header and rows keep their place, so nothing jumps. */
export function PageLoading({ narrow, label = "Loading" }: { narrow?: boolean; label?: string }) {
  return (
    <main className={narrow ? "page narrow" : "page"} aria-busy="true">
      <span className="sr-only">{label}…</span>
      <div className="stack-sm" aria-hidden="true">
        <span className="skeleton" style={{ width: 120, height: 12 }} />
        <span className="skeleton" style={{ width: "40%", height: 24 }} />
      </div>
      <div className="panel" style={{ marginTop: 32 }} aria-hidden="true">
        <div className="stack">
          {[72, 88, 64, 80, 70].map((w, i) => (
            <span key={i} className="skeleton" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    </main>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <span className="loading-label" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <main className="page narrow">
      <EmptyState
        icon="alertCircle"
        title="This page could not be loaded"
        action={
          onRetry && (
            <button className="btn" onClick={onRetry}>
              Try again
            </button>
          )
        }
      >
        {message}
      </EmptyState>
    </main>
  );
}

/** GET a URL; reloads when the URL changes. Errors become a message instead of a page stuck on loading. */
export function useApi<T>(url: string) {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null });
    api.get<T>(url).then(
      (data) => live && setState({ data, error: null }),
      (e) => live && setState({ data: null, error: e instanceof ApiError ? e.message : "Check your connection and try again." }),
    );
    return () => {
      live = false;
    };
  }, [url, n]);
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []) };
}

/** Dropdown of links or actions; closes on outside click, Escape and after choosing. */
export function Menu({ label, icon, children }: { label: ReactNode; icon?: IconName; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) {
        el.open = false;
        if (e instanceof KeyboardEvent) el.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  return (
    <details className="menu" ref={ref}>
      <summary className="btn">
        {icon && <Icon name={icon} />}
        {label}
        <Icon name="chevronDown" size={14} />
      </summary>
      <div className="menu-list" onClick={() => ref.current && (ref.current.open = false)}>
        {children}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- confirm dialog

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  /** The person must type this exact text before the confirm button works. */
  typeToConfirm?: string;
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);

/** `const confirm = useConfirm(); if (await confirm({...})) ...` in place of window.confirm. */
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const resolver = useRef<(ok: boolean) => void>();
  const dialog = useRef<HTMLDialogElement>(null);

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setTyped("");
        setOpts(o);
      }),
    [],
  );
  useEffect(() => {
    if (opts && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [opts]);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = undefined;
    dialog.current?.close();
    setOpts(null);
  };
  const blocked = !!opts?.typeToConfirm && typed !== opts.typeToConfirm;

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <dialog ref={dialog} className="dialog" aria-labelledby="confirm-title" onClose={() => opts && finish(false)}>
        {opts && (
          <form
            method="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) finish(true);
            }}
          >
            <div className="dialog-body">
              <h2 id="confirm-title">{opts.title}</h2>
              {opts.body && <p>{opts.body}</p>}
              {opts.typeToConfirm && (
                <label>
                  Type <span className="mono">{opts.typeToConfirm}</span> to confirm
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
                </label>
              )}
            </div>
            <div className="dialog-foot">
              <button type="button" className="btn ghost" onClick={() => finish(false)} autoFocus={!opts.typeToConfirm}>
                Cancel
              </button>
              <button type="submit" className={opts.danger ? "btn danger solid" : "btn primary"} disabled={blocked}>
                {opts.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </ConfirmCtx.Provider>
  );
}
