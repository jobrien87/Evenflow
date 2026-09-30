// Every one of the 75 training drills follows the exact same shape:
// a one-line hook, then five ALL-CAPS section headers separated by
// blank lines — WHY THIS WORKS, HOW TO RUN THIS DRILL, EXAMPLE,
// COMMON MISTAKES, PRACTICE SCENARIO. This parses that real, consistent
// structure into sections a page can render distinctly, without touching
// the underlying drill content itself.
const HEADER_RE = /\n\n\n([A-Z][A-Z &-]+)\n\n/g;

export function parseDrillContent(raw) {
  if (!raw) return { intro: '', sections: [] };
  const matches = [...raw.matchAll(HEADER_RE)];
  if (matches.length === 0) return { intro: raw.trim(), sections: [] };

  const intro = raw.slice(0, matches[0].index).trim();
  const sections = matches.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    return { heading: m[1].trim(), body: raw.slice(start, end).trim() };
  });
  return { intro, sections };
}

// "1. Do the thing" -> ['Do the thing', ...]
export function parseNumberedSteps(body) {
  return body
    .split('\n')
    .map((line) => line.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean);
}

// "- Some mistake" -> ['Some mistake', ...]
export function parseBulletList(body) {
  return body
    .split('\n')
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

// "Agent: line\nProspect: line" -> [{ speaker: 'Agent', line: '...' }, ...]
export function parseDialogue(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(Agent|Prospect):\s*(.*)$/);
      return m ? { speaker: m[1], line: m[2] } : { speaker: null, line };
    });
}
