/**
 * The glyph for an uploaded file, by broad category.
 *
 * Deliberately six categories rather than one per extension. The point of the
 * mark is to be told apart at a glance in a list — text from image from
 * archive — and a bespoke icon for `.tsx` against `.ts` is a distinction the
 * filename already makes better than a 16px drawing can.
 *
 * The colour comes from the same `--k-soft`/`--k-ink` pair the artefacts table
 * uses, so a file row and an artefact row read as the same kind of object.
 */

export type FileCategory = "text" | "image" | "pdf" | "sheet" | "archive" | "other";

const BY_EXTENSION: Record<string, FileCategory> = {
  csv: "sheet", tsv: "sheet", xlsx: "sheet", xls: "sheet", numbers: "sheet",
  zip: "archive", tar: "archive", gz: "archive", tgz: "archive", rar: "archive",
  "7z": "archive", bz2: "archive", xz: "archive",
  pdf: "pdf",
};

export function categorise(name: string, contentType: string): FileCategory {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  // Extension first: a .csv arrives as text/csv, and reading it as plain text
  // would lose the one thing a person scanning the list is looking for.
  const byExt = BY_EXTENSION[ext];
  if (byExt) return byExt;

  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || type.includes("json") || type.includes("xml")) return "text";
  if (type.includes("zip") || type.includes("compressed") || type.includes("tar")) return "archive";
  return "other";
}

export function FileIcon({ category, size = 16 }: { category: FileCategory; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none" as const,
    "aria-hidden": true,
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  if (category === "image")
    return (
      <svg {...p}>
        <rect x="2" y="3.2" width="12" height="9.6" rx="1.4" />
        <circle cx="5.6" cy="6.4" r="1" />
        <path d="M2.4 11.2l3.2-2.8 2.8 2.4 2.2-1.8 3 2.6" />
      </svg>
    );

  if (category === "pdf")
    return (
      <svg {...p}>
        <path d="M4 1.8h5l3 3v9.4H4z" />
        <path d="M9 1.8v3h3" />
        <path d="M6.1 11.4c1.6-.6 2.6-2 3-3.3.3-1-.4-1.6-.9-1-.6.8.4 3 3.1 3.4" />
      </svg>
    );

  if (category === "sheet")
    return (
      <svg {...p}>
        <rect x="2" y="3" width="12" height="10" rx="1.4" />
        <path d="M2 6.4h12M6.4 6.4V13M10.2 6.4V13" />
      </svg>
    );

  if (category === "archive")
    return (
      <svg {...p}>
        <path d="M2 5.4h12v7.2a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 12.6z" />
        <path d="M1.6 2.8h12.8v2.6H1.6zM7 8.2h2" />
      </svg>
    );

  if (category === "text")
    return (
      <svg {...p}>
        <path d="M4 1.8h5l3 3v9.4H4z" />
        <path d="M9 1.8v3h3M6 8.4h4M6 10.8h2.6" />
      </svg>
    );

  return (
    <svg {...p}>
      <path d="M4 1.8h5l3 3v9.4H4z" />
      <path d="M9 1.8v3h3" />
    </svg>
  );
}
