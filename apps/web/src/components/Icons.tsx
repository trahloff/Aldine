/** Aldine icon set — inline SVG, 1.5px stroke, currentColor. Native-feel replacements for emoji. */
import { SVGProps } from 'react';

const base = (props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> => ({
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  ...props,
});

export const IconDoc = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 1.75h5.5L13 5.25v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
    <path d="M9.5 1.75v3.5H13" />
    <path d="M5.5 8.5h5M5.5 11h5" />
  </svg>
);

export const IconBook = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M2.5 2.75A1.25 1.25 0 0 1 3.75 1.5H13a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5H3.75a1.25 1.25 0 0 1-1.25-1.25V2.75Z" />
    <path d="M2.5 11.5c0-.69.56-1.25 1.25-1.25H13.5" />
    <path d="M5.5 4.5h5" />
  </svg>
);

export const IconStar = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} fill="currentColor" strokeWidth={0}>
    <path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 0.7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.6Z" />
  </svg>
);

export const IconImage = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <circle cx="5.5" cy="6" r="1.1" fill="currentColor" strokeWidth={0} />
    <path d="M2.5 11.5 6 8l3 3 2-2 2.5 2.5" />
  </svg>
);

export const IconFile = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)}>
    <path d="M4 1.75h5.5L13 5.25v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" />
    <path d="M9.5 1.75v3.5H13" />
  </svg>
);

export const IconChevronLeft = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} width={15} height={15}>
    <path d="M10 2.5 4.8 8 10 13.5" />
  </svg>
);

export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} width={12} height={12}>
    <path d="M6.5 9.5 9.5 6.5" />
    <path d="M7.5 4 9 2.5a2.47 2.47 0 0 1 3.5 3.5L11 7.5" />
    <path d="M5 8.5 3.5 10A2.47 2.47 0 0 0 7 13.5L8.5 12" />
  </svg>
);

/** Spark/asterisk glyph — the agent avatar (an initial would collide with human names). */
export const IconSpark = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} width={12} height={12}>
    <path d="M8 1.5v13" />
    <path d="M2.4 4.75l11.2 6.5" />
    <path d="M13.6 4.75l-11.2 6.5" />
  </svg>
);

export const IconX = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base(p)} width={11} height={11}>
    <path d="M3 3l10 10M13 3 3 13" />
  </svg>
);

/** Icon for a file path. */
export function fileIcon(path: string, isRoot: boolean) {
  if (isRoot) return <IconStar style={{ color: 'var(--warn)' }} />;
  if (path.endsWith('.tex')) return <IconDoc />;
  if (path.endsWith('.bib')) return <IconBook />;
  if (/\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(path)) return <IconImage />;
  return <IconFile />;
}
