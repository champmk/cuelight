// The application menu bar — File / Edit / View / Run / Help, drawn in-app
// (native Windows menus can't follow the theme). Standard menu mechanics:
// click a root to open, hover slides between roots while one is open,
// Escape or any outside click closes, disabled items are visibly inert.

import { useEffect, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  /** Radio/check state (e.g. the active theme). */
  checked?: boolean;
  danger?: boolean;
  onClick?: () => void;
}

export type MenuEntry = MenuItem | "---";

export interface Menu {
  label: string;
  items: MenuEntry[];
}

export function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const close = (ev: MouseEvent) => {
      if (ref.current && !ref.current.contains(ev.target as Node)) setOpen(null);
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setOpen(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="menubar" ref={ref}>
      {menus.map((m, i) => (
        <div key={m.label} className="mroot-wrap">
          <button
            className={`mroot ${open === i ? "open" : ""}`}
            onClick={(ev) => {
              ev.stopPropagation();
              setOpen((o) => (o === i ? null : i));
            }}
            onMouseEnter={() => {
              if (open !== null && open !== i) setOpen(i);
            }}
          >
            {m.label}
          </button>
          {open === i && (
            <div className="mdrop" onClick={(ev) => ev.stopPropagation()}>
              {m.items.map((item, j) =>
                item === "---" ? (
                  <div key={j} className="msep" />
                ) : (
                  <button
                    key={j}
                    className={`mitem ${item.disabled ? "off" : ""} ${item.danger ? "danger" : ""}`}
                    disabled={item.disabled}
                    onClick={() => {
                      if (item.disabled) return;
                      setOpen(null);
                      item.onClick?.();
                    }}
                  >
                    <span className="mi-check">{item.checked ? "✓" : ""}</span>
                    <span className="mi-label">{item.label}</span>
                    {item.shortcut && <span className="mi-key">{item.shortcut}</span>}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
