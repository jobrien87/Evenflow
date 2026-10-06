import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { SectionHeader, Badge } from '../ui';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function toggleLetter(letters, letter) {
  return letters.includes(letter) ? letters.filter((l) => l !== letter) : [...letters, letter].sort();
}

export default function OfficesPanel() {
  const { officeId } = useParams();
  const navigate = useNavigate();
  const [office, setOffice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [cities, setCities] = useState([]);
  const [newCity, setNewCity] = useState('');
  const [zipRanges, setZipRanges] = useState([]);
  const [newRangeStart, setNewRangeStart] = useState('');
  const [newRangeEnd, setNewRangeEnd] = useState('');
  const [isDefaultOffice, setIsDefaultOffice] = useState(false);
  const [routingMode, setRoutingMode] = useState('ROUND_ROBIN');
  const [geoError, setGeoError] = useState('');
  const [geoSaving, setGeoSaving] = useState(false);
  const [geoSaved, setGeoSaved] = useState(false);

  const [assignments, setAssignments] = useState([]); // [{userId, letters, isFallback}]
  const [alphaError, setAlphaError] = useState('');
  const [alphaSaving, setAlphaSaving] = useState(false);
  const [alphaSaved, setAlphaSaved] = useState(false);

  useEffect(() => {
    load();
  }, [officeId]);

  async function load() {
    setLoading(true);
    setLoadError('');
    try {
      const data = await api.offices();
      const found = (data.offices || []).find((o) => o.id === officeId);
      if (!found) {
        setLoadError('Office not found.');
        return;
      }
      setOffice(found);
      setCities(found.routingCities || []);
      let ranges = [];
      try {
        ranges = Array.isArray(found.routingZipRanges) ? found.routingZipRanges : JSON.parse(found.routingZipRanges || '[]');
      } catch {
        ranges = [];
      }
      setZipRanges(ranges);
      setIsDefaultOffice(!!found.isDefaultOffice);
      setRoutingMode(found.routingMode || 'ROUND_ROBIN');
      const existingByUser = new Map((found.alphaAssignments || []).map((a) => [a.userId, a]));
      setAssignments(
        (found.users || []).map((u) => {
          const existing = existingByUser.get(u.id);
          return { userId: u.id, name: `${u.firstName} ${u.lastName}`, letters: existing?.letters || [], isFallback: existing?.isFallback || false };
        })
      );
    } catch (err) {
      setLoadError(err.data?.message || 'Failed to load this office.');
    } finally {
      setLoading(false);
    }
  }

  function addCity() {
    const trimmed = newCity.trim();
    if (!trimmed) return;
    setCities([...new Set([...cities, trimmed.toUpperCase()])]);
    setNewCity('');
  }

  function addZipRange() {
    const start = newRangeStart.trim().padStart(5, '0');
    const end = newRangeEnd.trim().padStart(5, '0');
    if (!/^[0-9]{5}$/.test(start) || !/^[0-9]{5}$/.test(end)) {
      setGeoError('Zip range start/end must each be a 5-digit zip code.');
      return;
    }
    if (start > end) {
      setGeoError('Zip range start must be less than or equal to end.');
      return;
    }
    setGeoError('');
    setZipRanges([...zipRanges, { start, end }]);
    setNewRangeStart('');
    setNewRangeEnd('');
  }

  async function saveGeography() {
    setGeoError('');
    setGeoSaved(false);
    setGeoSaving(true);
    try {
      await api.updateOffice(officeId, { routingCities: cities, routingZipRanges: zipRanges, isDefaultOffice, routingMode });
      setGeoSaved(true);
      await load();
    } catch (err) {
      setGeoError(err.data?.message || 'Failed to save routing rules — check for a conflict with another office.');
    } finally {
      setGeoSaving(false);
    }
  }

  function updateAssignment(userId, patch) {
    setAssignments(assignments.map((a) => (a.userId === userId ? { ...a, ...patch } : a)));
  }

  async function saveAlphaAssignments() {
    setAlphaError('');
    setAlphaSaved(false);
    const withLetters = assignments.filter((a) => a.letters.length > 0 || a.isFallback);
    const fallbackCount = withLetters.filter((a) => a.isFallback).length;
    if (withLetters.length > 0 && fallbackCount !== 1) {
      setAlphaError('Exactly one producer must be marked as the fallback for any unclaimed letter.');
      return;
    }
    setAlphaSaving(true);
    try {
      await api.setOfficeAlphaAssignments(
        officeId,
        withLetters.map((a) => ({ userId: a.userId, letters: a.isFallback ? [] : a.letters, isFallback: a.isFallback }))
      );
      setAlphaSaved(true);
      await load();
    } catch (err) {
      setAlphaError(err.data?.message || 'Failed to save letter assignments.');
    } finally {
      setAlphaSaving(false);
    }
  }

  if (loading) return <div style={s.wrap}><div style={s.hint}>Loading…</div></div>;
  if (loadError || !office) return <div style={s.wrap}><div style={s.loadErrorBox}>{loadError || 'Office not found.'}</div></div>;

  return (
    <div style={s.wrap}>
      <button style={s.backLink} onClick={() => navigate(-1)}>&larr; BACK</button>
      <SectionHeader>CONFIGURE ROUTING — {office.name}</SectionHeader>

      <section style={s.section}>
        <h3 style={s.h3}>GEOGRAPHY</h3>
        <div style={s.hint}>
          A lead whose zip or city matches one of these rules auto-routes to this office (stage 1). If nothing
          matches any office, the default office (if any) is used, else this agency's existing round-robin-across-offices
          fallback runs. Set at most one office as the default.
        </div>

        <div style={s.fieldBlock}>
          <label style={s.fieldLabel}>CITIES (exact match)</label>
          <div style={s.chipRow}>
            {cities.map((c) => (
              <Badge key={c} tone="info">
                {c} <button style={s.chipRemove} onClick={() => setCities(cities.filter((x) => x !== c))}>×</button>
              </Badge>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={s.input} placeholder="e.g. TALLAHASSEE" value={newCity} onChange={(e) => setNewCity(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addCity()} />
            <button style={s.smallButton} onClick={addCity} type="button">+ ADD CITY</button>
          </div>
        </div>

        <div style={s.fieldBlock}>
          <label style={s.fieldLabel}>ZIP RANGES</label>
          {zipRanges.map((r, i) => (
            <div key={i} style={s.rangeRow}>
              <span>{r.start} – {r.end}</span>
              <button style={s.smallButtonOutline} onClick={() => setZipRanges(zipRanges.filter((_, idx) => idx !== i))}>REMOVE</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input style={s.miniInput} placeholder="Start (32301)" value={newRangeStart} onChange={(e) => setNewRangeStart(e.target.value)} />
            <span>–</span>
            <input style={s.miniInput} placeholder="End (32399)" value={newRangeEnd} onChange={(e) => setNewRangeEnd(e.target.value)} />
            <button style={s.smallButton} onClick={addZipRange} type="button">+ ADD RANGE</button>
          </div>
        </div>

        <div style={s.fieldBlock}>
          <label style={s.checkboxLabel}>
            <input type="checkbox" checked={isDefaultOffice} onChange={(e) => setIsDefaultOffice(e.target.checked)} />
            Make this the default office (geography fallback for any unmatched lead)
          </label>
        </div>

        <div style={s.fieldBlock}>
          <label style={s.fieldLabel}>PRODUCER ROUTING MODE (within this office)</label>
          <select style={s.input} value={routingMode} onChange={(e) => setRoutingMode(e.target.value)}>
            <option value="ROUND_ROBIN">Round Robin — cycles through this office's active producers</option>
            <option value="ALPHA_SPLIT">Alpha Split — explicit last-name letter assignment (configure below)</option>
          </select>
        </div>

        {geoError && <div style={s.formError}>{geoError}</div>}
        {geoSaved && <div style={s.savedNote}>Saved.</div>}
        <button style={s.submitButton} onClick={saveGeography} disabled={geoSaving}>{geoSaving ? 'SAVING…' : 'SAVE GEOGRAPHY & ROUTING MODE'}</button>
      </section>

      {routingMode === 'ALPHA_SPLIT' && (
        <section style={s.section}>
          <h3 style={s.h3}>ALPHA ASSIGNMENTS</h3>
          <div style={s.hint}>
            Pick which starting last-name letters each producer at this office owns. Exactly one producer must be the
            fallback — they get any letter nobody else claims. A producer not assigned to this office can't be given letters here.
          </div>
          {assignments.length === 0 && <div style={s.hint}>No active producers are assigned to this office yet — assign them from Main Stage's TEAM section first.</div>}
          {assignments.map((a) => (
            <div key={a.userId} style={s.assignmentRow}>
              <div style={s.rowTitle}>{a.name}</div>
              <div style={s.letterGrid}>
                {ALPHABET.map((letter) => (
                  <button
                    key={letter}
                    type="button"
                    style={{ ...s.letterTile, ...(a.letters.includes(letter) ? s.letterTileActive : {}) }}
                    disabled={a.isFallback}
                    onClick={() => updateAssignment(a.userId, { letters: toggleLetter(a.letters, letter) })}
                  >
                    {letter}
                  </button>
                ))}
              </div>
              <label style={s.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={a.isFallback}
                  onChange={(e) => updateAssignment(a.userId, { isFallback: e.target.checked, letters: e.target.checked ? [] : a.letters })}
                />
                Fallback for unclaimed letters
              </label>
            </div>
          ))}
          {alphaError && <div style={s.formError}>{alphaError}</div>}
          {alphaSaved && <div style={s.savedNote}>Saved.</div>}
          {assignments.length > 0 && (
            <button style={s.submitButton} onClick={saveAlphaAssignments} disabled={alphaSaving}>{alphaSaving ? 'SAVING…' : 'SAVE ALPHA ASSIGNMENTS'}</button>
          )}
        </section>
      )}
    </div>
  );
}

const s = {
  wrap: {},
  hint: { color: 'var(--text-muted)', fontSize: 12, marginBottom: 12, lineHeight: 1.5 },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13 },
  backLink: { background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginBottom: 12, padding: 0 },
  section: { marginTop: 24, background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 16 },
  h3: { margin: '0 0 8px', fontSize: 14, letterSpacing: 1 },
  fieldBlock: { marginBottom: 16 },
  fieldLabel: { display: 'block', color: 'var(--text-secondary)', fontSize: 11, letterSpacing: 1, fontWeight: 700, marginBottom: 6 },
  chipRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  chipRemove: { background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', marginLeft: 4, fontWeight: 700 },
  input: { padding: '10px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', flex: 1 },
  miniInput: { padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', width: 110 },
  rangeRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border-hairline)', fontSize: 13 },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' },
  smallButton: { padding: '8px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' },
  smallButtonOutline: { padding: '6px 10px', background: 'transparent', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', borderRadius: 6, cursor: 'pointer', fontSize: 11 },
  submitButton: { padding: '10px 16px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', marginTop: 8 },
  formError: { color: 'var(--danger)', fontSize: 13, marginTop: 8 },
  savedNote: { color: 'var(--accent)', fontSize: 12, marginTop: 8, fontWeight: 700 },
  assignmentRow: { background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, padding: 12, marginBottom: 10 },
  rowTitle: { fontWeight: 600, fontSize: 14, marginBottom: 8 },
  letterGrid: { display: 'grid', gridTemplateColumns: 'repeat(13, 1fr)', gap: 4, marginBottom: 8 },
  letterTile: { padding: '6px 0', background: 'var(--bg-elevated)', border: '1px solid var(--border-hairline)', borderRadius: 4, color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11, fontWeight: 700 },
  letterTileActive: { background: 'var(--accent)', color: 'var(--accent-on, #000)', borderColor: 'var(--accent)' },
};
