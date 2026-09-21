// A small set of thin hairline-stroke icons — no icon library dependency,
// consistent with this app's minimal-dependency approach. 24x24 viewBox,
// stroke=currentColor so they inherit text color automatically.
const PATHS = {
  home: 'M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-9z',
  leads: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 3-5 6-5s6 2 6 5M14 20c0-2.5 2-4.2 4.5-4.8M22 20c0-2.5-2-4.2-4.5-4.8',
  transfer: 'M4 7h13l-3-3M20 17H7l3 3M4 7v10M20 17V7',
  vendor: 'M3 9l1-5h16l1 5M4 9v10h16V9M4 9h16M10 13h4',
  dollar: 'M12 3v18M8 7.5c0-1.5 1.8-2.5 4-2.5s4 1.2 4 2.8-1.8 2.4-4 2.7-4 1.4-4 2.9 1.8 2.6 4 2.6 4-1 4-2.5',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.5a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.3-.9a7 7 0 0 0 2 1.2L10 21h4l.6-2.5a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.6a7 7 0 0 0 .1-1.2z',
  support: 'M12 3a9 9 0 0 0-9 9v6a2 2 0 0 0 2 2h2v-7H5v-1a7 7 0 1 1 14 0v1h-2v7h2a2 2 0 0 0 2-2v-6a9 9 0 0 0-9-9z',
  phone: 'M6 3h4l1.5 4.5L9 9.5a13 13 0 0 0 5.5 5.5l2-2.5L21 14v4a2 2 0 0 1-2 2C10.5 20 4 13.5 4 5a2 2 0 0 1 2-2z',
  card: 'M3 6h18v12H3V6zm0 4h18M7 15h4',
  book: 'M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4zm0 0v13a3 3 0 0 0 3 3h9',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-4a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  flag: 'M6 21V4m0 1h11l-2.5 3.5L17 12H6',
  agencies: 'M4 21V8l8-5 8 5v13M4 21h16M9 21v-6h6v6',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h1l2 5h2l-1.5-5H12l7 3V6l-7 3H4a1 1 0 0 0-1 1z',
  ticket: 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8z',
  chat: 'M4 4h16v11H8l-4 4V4z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6L6 18',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  download: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
};

export default function Icon({ name, size = 18, style }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d={d} />
    </svg>
  );
}
