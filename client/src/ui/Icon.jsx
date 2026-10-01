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
  upload: 'M12 15V3m0 0L8 7m4-4l4 4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  vinyl: 'M4 12a8 8 0 1 0 16 0 8 8 0 1 0-16 0zM9 12a3 3 0 1 0 6 0 3 3 0 1 0-6 0zM11.25 12a0.75 0.75 0 1 0 1.5 0 0.75 0.75 0 1 0-1.5 0z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 15l0.8 2.2L22 18l-2.2 0.8L19 21l-0.8-2.2L16 18l2.2-0.8L19 15z',
  trophy: 'M8 4h8v4a4 4 0 0 1-8 0V4zM5 5H3v2a4 4 0 0 0 4 4M19 5h2v2a4 4 0 0 1-4 4M9 15h6M12 12v5M8 20h8',
  flame: 'M12 2c1 3-3 4-3 8a3 3 0 0 0 6 0c1.5 1 2 3 2 4.5A5.5 5.5 0 0 1 6 14.5C6 9 12 7 12 2z',
  checklist: 'M4 6h2v2H4V6zM4 11h2v2H4v-2zM4 16h2v2H4v-2zM9 7h11M9 12h11M9 17h11',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  mail: 'M4 6h16v12H4V6zm0 0l8 7 8-7',
  pencil: 'M4 20h4l10.5-10.5a2.5 2.5 0 0 0-3.5-3.5L4 16v4zM14 6l4 4',
  refresh: 'M4 12a8 8 0 0 1 14-5.3M20 3v5h-5M20 12a8 8 0 0 1-14 5.3M4 21v-5h5',
  tag: 'M12 2h7a1 1 0 0 1 1 1v7a2 2 0 0 1-.6 1.4l-8 8a2 2 0 0 1-2.8 0l-6-6a2 2 0 0 1 0-2.8l8-8A2 2 0 0 1 12 2zM16.5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  car: 'M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11m-14 0h14m-14 0a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-1h10v1a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1M7 15h.01M17 15h.01',
  heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  pulse: 'M22 12h-4l-3 9L9 3l-3 9H2',
  key: 'M15.5 7.5a3 3 0 1 1-4.24 4.24L4 19v2h2l1-1h2v-2h2l1.76-1.76A3 3 0 0 1 15.5 7.5z',
  briefcase: 'M10 5h4v2h-4V5zM4 9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9zM2 13h20',
  palette: 'M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 2.5-2.5v-.5a1.5 1.5 0 0 1 1.5-1.5H19a2 2 0 0 0 2-2A9 9 0 0 0 12 3z M8 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M11 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M16 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M18 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  handshake: 'M2 12l5-5 4 2 3-3 5 5-3 3-1-1-3 3-4-2-3 1z M14 9l3 3M11 12l3 3',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM19 11a7 7 0 0 1-14 0M12 18v3M9 21h6',
  speaker: 'M4 9h4l5-4v14l-5-4H4V9zM16 8a5 5 0 0 1 0 8M18.5 6a8 8 0 0 1 0 12',
  building: 'M4 21V6l7-3 7 3v15M4 21h16M9 9h1M9 13h1M14 9h1M14 13h1M9 21v-5h6v5',
  cake: 'M4 21v-8a2 2 0 0 1 2-2h1V9a1 1 0 0 1 2 0v2h1v-2a1 1 0 0 1 2 0v2h1v-2a1 1 0 0 1 2 0v2h1a2 2 0 0 1 2 2v8zM4 17h16M11 3a1 1 0 1 0 2 0c0-1-1-1-1-2',
  alert: 'M12 3l10 18H2L12 3zM12 10v4M12 17h.01',
  send: 'M21 3L3 10.5l7 3.5m11-11l-6.5 17-4.5-7.5m11-9.5l-11 9.5',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 0 1 4.9.75c0 1.5-2.4 1.75-2.4 3.25M12 17h.01',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  play: 'M6 4l14 8-14 8V4z',
  link: 'M9 15l6-6M8 16l-2 2a4 4 0 0 1-5.66-5.66l3-3A4 4 0 0 1 9 8M15 8l2-2a4 4 0 0 1 5.66 5.66l-3 3A4 4 0 0 1 15 16',
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
