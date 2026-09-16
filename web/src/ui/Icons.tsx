/**
 * Inline 20×20 stroke icons.
 *
 * Hand-written rather than a dependency: the set is small, they inherit
 * `currentColor`, and shipping an icon library for a dozen glyphs is weight the
 * bundle doesn't need.
 */

type P = { size?: number };

const base = (size = 20) => ({
  width: size,
  height: size,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const IconCursor = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M4.5 3.2l11 5.6-4.7 1.3-1.9 4.6-4.4-11.5z" />
  </svg>
);

export const IconPen = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M13.4 3.6l3 3L8 15l-4 1 1-4 8.4-8.4z" />
    <path d="M12 5l3 3" />
  </svg>
);

export const IconEraser = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M8.6 15.5H16" />
    <path d="M11.8 4.6l3.6 3.6a1.3 1.3 0 010 1.9l-5 5a1.3 1.3 0 01-1.9 0l-3.6-3.6a1.3 1.3 0 010-1.9l5-5a1.3 1.3 0 011.9 0z" />
  </svg>
);

export const IconCard = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4.5" width="14" height="11" rx="2" />
    <path d="M6 8h6M6 11h4" />
  </svg>
);

export const IconNote = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M4 4.5h12v7.5l-4 4H4z" />
    <path d="M16 12h-4v4" />
  </svg>
);

export const IconImage = ({ size }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="4.5" width="14" height="11" rx="2" />
    <circle cx="7.5" cy="8.5" r="1.2" />
    <path d="M3.6 13.6l3.6-3.2 3.2 2.8 2.4-2 3.6 3.1" />
  </svg>
);

export const IconUndo = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M7 6.5L3.8 9.3 7 12" />
    <path d="M3.8 9.3H12a4 4 0 010 8h-3" />
  </svg>
);

export const IconRedo = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M13 6.5l3.2 2.8L13 12" />
    <path d="M16.2 9.3H8a4 4 0 000 8h3" />
  </svg>
);

export const IconPlus = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M10 4.5v11M4.5 10h11" />
  </svg>
);

export const IconClose = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
  </svg>
);

export const IconMore = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="10" cy="4.8" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="15.2" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconTrash = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M4.5 6h11M8 6V4.6h4V6M6.4 6l.6 9.4h6l.6-9.4" />
  </svg>
);

export const IconExpand = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M12 4h4v4M8 16H4v-4M16 4l-5 5M4 16l5-5" />
  </svg>
);

export const IconCollapse = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M15 9h-4V5M5 11h4v4M11 9l5-5M9 11l-5 5" />
  </svg>
);

export const IconLogout = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M8 4.5H5.2A1.2 1.2 0 004 5.7v8.6a1.2 1.2 0 001.2 1.2H8" />
    <path d="M11.5 7l3 3-3 3M14.5 10H8" />
  </svg>
);

export const IconMap = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="10" cy="5" r="2" />
    <circle cx="4.8" cy="14.6" r="2" />
    <circle cx="15.2" cy="14.6" r="2" />
    <path d="M8.7 6.8l-2.6 6M11.3 6.8l2.6 6M6.8 14.6h6.4" />
  </svg>
);

export const IconGrip = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="7.5" cy="5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="5" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="7.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="7.5" cy="15" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="15" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const IconGear = ({ size }: P) => (
  <svg {...base(size)}>
    <circle cx="10" cy="10" r="2.6" />
    <path d="M10 2.6v1.8M10 15.6v1.8M17.4 10h-1.8M4.4 10H2.6M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3M15.2 15.2l-1.3-1.3M6.1 6.1 4.8 4.8" />
  </svg>
);

export const IconHome = ({ size }: P) => (
  <svg {...base(size)}>
    <path d="M3.2 8.4 10 3.2l6.8 5.2" />
    <path d="M4.8 9.6v6.2h10.4V9.6" />
  </svg>
);
