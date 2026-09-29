/**
 * The glyph for an artefact kind.
 *
 * Shared by the board node and the Artefacts grid so the same thing is drawn
 * the same way in both places — a sheet that looks like a grid on the canvas
 * and like something else in the list is two things, not one.
 */

import type { ArtefactKind } from "./artefact";

export function KindIcon({ kind, size = 13 }: { kind: ArtefactKind; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none" as const,
    "aria-hidden": true,
    stroke: "currentColor",
    strokeWidth: 1.3,
  };

  if (kind === "doc")
    return (
      <svg {...p}>
        <path d="M4 1.8h5l3 3v9.4H4z" />
        <path d="M9 1.8v3h3M6 8h4M6 10.6h4" />
      </svg>
    );

  if (kind === "deck")
    return (
      <svg {...p}>
        <rect x="1.8" y="3" width="12.4" height="8.6" rx="1.4" />
        <path d="M6 13.8h4" strokeLinecap="round" />
      </svg>
    );

  if (kind === "folder")
    return (
      <svg {...p}>
        <path d="M1.8 4.2a1.4 1.4 0 0 1 1.4-1.4h2.9l1.5 1.8h5.2a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.2a1.4 1.4 0 0 1-1.4-1.4z" />
      </svg>
    );

  if (kind === "file")
    return (
      <svg {...p}>
        <path d="M4 1.8h5l3 3v9.4H4z" />
        <path d="M9 1.8v3h3" />
      </svg>
    );

  if (kind === "html")
    return (
      <svg {...p}>
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4" />
        <path d="M1.8 6h12.4M4.2 4.4h.01M6.2 4.4h.01" strokeLinecap="round" />
      </svg>
    );

  return (
    <svg {...p}>
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" />
      <path d="M1.8 6.2h12.4M6.2 6.2v7.2M10.4 6.2v7.2" />
    </svg>
  );
}
