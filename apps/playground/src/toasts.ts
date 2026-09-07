/**
 * Small top-right notices that fade on their own — the HUD's answer to
 * "a friend just came online" when the chat log has scrolled past it. Pure
 * DOM, no framework; a toast is text plus an optional kind for the glyph
 * (meaning is never carried by colour alone).
 */

const CSS = `
.hg-toasts{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:6px;z-index:9500;pointer-events:none}
.hg-toast{background:rgba(13,17,23,.92);border:1px solid #30363d;border-left:3px solid #58a6ff;border-radius:8px;color:#e6edf3;padding:7px 12px;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.45);opacity:0;transform:translateY(-6px);transition:opacity .18s ease,transform .18s ease}
.hg-toast.in{opacity:1;transform:none}
.hg-toast.friend{border-left-color:#3fb950}
.hg-toast.party{border-left-color:#d29922}
.hg-toast.guild{border-left-color:#a371f7}
.hg-toast b{font-weight:600}
`;

export type ToastKind = "info" | "friend" | "party" | "guild";

export interface Toasts {
  show(text: string, kind?: ToastKind, ms?: number): void;
  dispose(): void;
}

export function mountToasts(): Toasts {
  if (!document.getElementById("hg-toasts-css")) {
    const style = document.createElement("style");
    style.id = "hg-toasts-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const root = document.createElement("div");
  root.className = "hg-toasts";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  document.body.appendChild(root);
  const glyph: Record<ToastKind, string> = { info: "•", friend: "☺", party: "⚑", guild: "⚔" };
  return {
    show(text, kind = "info", ms = 5000) {
      const node = document.createElement("div");
      node.className = `hg-toast ${kind}`;
      const b = document.createElement("b");
      b.textContent = `${glyph[kind]} `;
      node.append(b, text);
      root.appendChild(node);
      while (root.children.length > 5) root.firstElementChild?.remove();
      requestAnimationFrame(() => node.classList.add("in"));
      setTimeout(() => {
        node.classList.remove("in");
        setTimeout(() => node.remove(), 220);
      }, ms);
    },
    dispose() {
      root.remove();
    },
  };
}
