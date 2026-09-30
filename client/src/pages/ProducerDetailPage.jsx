import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader, StatTile, ProgressRing, EmptyState, MicButton } from '../ui';

const PERIODS = [
  { key: 'month', label: 'This month', from: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); } },
  { key: 'quarter', label: 'This quarter', from: () => { const d = new Date(); return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); } },
  { key: 'week', label: 'This week', from: () => { const d = new Date(); const day = d.getDay(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); } },
];

const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);

export default function ProducerDetailPage() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const [periodKey, setPeriodKey] = useState('month');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [periodKey, userId]);

  async function load() {
    setError('');
    try {
      const period = PERIODS.find((p) => p.key === periodKey);
      const from = period.from().toISOString();
      const to = new Date().toISOString();
      const res = await api.userPerformance(userId, `?from=${from}&to=${to}`);
      setData(res);
    } catch (err) {
      setError(err.data?.message || 'Could not load this producer\'s performance. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }

  async function updatePhone(phone) {
    const res = await api.updateUser(userId, { phone });
    setData((d) => ({ ...d, user: { ...d.user, phone: res.user.phone } }));
  }

  if (loading) return <div style={s.wrap}>Loading…</div>;

  if (error || !data) {
    return (
      <div style={s.wrap}>
        <div style={s.loadErrorBox}>
          {error || 'Could not load this producer.'}
          <button style={s.retryButton} onClick={load}>RETRY</button>
        </div>
      </div>
    );
  }

  const { user, snapshot, explanation, componentPlaceholders, funnel, vendorBreakdown, productBreakdown } = data;

  return (
    <div style={s.wrap}>
      <div style={s.headerRow}>
        <div>
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>← BACK</Button>
          <h3 style={s.h3}>{user.firstName} {user.lastName}</h3>
        </div>
        <div style={s.periodRow}>
          {PERIODS.map((p) => (
            <button key={p.key} style={s.periodBtn(periodKey === p.key)} onClick={() => setPeriodKey(p.key)}>{p.label}</button>
          ))}
        </div>
      </div>

      <Card style={s.section}>
        <SectionHeader>FLOW SCORE</SectionHeader>
        {!snapshot ? (
          <>
            <div style={s.scoreRow}>
              <ProgressRing value={null} size={88} strokeWidth={7} />
              <div style={s.driversWrap}>
                <div style={s.sectionLabel}>WHAT THIS TRACKS</div>
                {(componentPlaceholders || []).map((c) => (
                  <div key={c.key} style={s.driverRow}>
                    <span>{c.label}</span>
                    <span style={s.noDataYet}>No data yet</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={s.excludedNote}>Not enough activity yet to compute a Flow Score.</div>
          </>
        ) : (
          <>
            <div style={s.scoreRow}>
              <ProgressRing value={snapshot.score} size={88} strokeWidth={7} />
              <div style={s.driversWrap}>
                {explanation.strongestAreas.length > 0 && (
                  <div>
                    <div style={s.sectionLabel}>STRONGEST AREA</div>
                    {explanation.strongestAreas.map((c) => (
                      <div key={c.label} style={s.driverRow}>
                        <span>{c.label}{c.lowConfidence ? ' (limited data)' : ''}</span>
                        <span style={s.driverValuePositive}>{c.value}%</span>
                      </div>
                    ))}
                  </div>
                )}
                {explanation.biggestOpportunities.length > 0 && (
                  <div>
                    <div style={s.sectionLabel}>BIGGEST OPPORTUNITY</div>
                    {explanation.biggestOpportunities.map((c) => (
                      <div key={c.label} style={s.driverRow}>
                        <span>{c.label}{c.lowConfidence ? ' (limited data)' : ''}</span>
                        <span style={s.driverValueNegative}>{c.value}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {explanation.excludedComponents.length > 0 && (
              <div style={s.excludedNote}>
                Not yet factored in (no data yet): {explanation.excludedComponents.map((c) => c.label).join(', ')}
              </div>
            )}
          </>
        )}
      </Card>

      <CoachingHelperSection userId={userId} user={user} onPhoneSaved={updatePhone} />

      <Card style={s.section}>
        <SectionHeader>FUNNEL</SectionHeader>
        <div style={s.statsRow}>
          <StatTile label="Total Leads" value={funnel?.totalLeads ?? 0} />
          <StatTile label="Contact Rate" value={pct(funnel?.contactRate)} sub={funnel?.contactRateSampleSize ? `n=${funnel.contactRateSampleSize}` : undefined} />
          <StatTile label="Quote Rate" value={pct(funnel?.quoteRate)} />
          <StatTile label="Close Rate" value={pct(funnel?.closeRate)} />
          <StatTile
            label="Speed to First Attempt"
            value={funnel?.speedToFirstAttemptMedianMinutes != null ? `${Math.round(funnel.speedToFirstAttemptMedianMinutes)}m` : '—'}
          />
        </div>
      </Card>

      <section style={s.section}>
        <SectionHeader>Where They're Struggling / Doing Great — By Vendor</SectionHeader>
        {(vendorBreakdown || []).length === 0 ? (
          <EmptyState title="No vendor leads this period" description="This producer hasn't received any vendor-sourced leads in the selected date range." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRow}>
              <span style={s.colVendor}>VENDOR</span>
              <span style={s.col}>LEADS</span>
              <span style={s.col}>UNTOUCHED</span>
              <span style={s.col}>CONTACT%</span>
              <span style={s.col}>QUOTE%</span>
              <span style={s.col}>CLOSE%</span>
            </div>
            {vendorBreakdown.map((v) => (
              <div key={v.vendorId} style={s.tableRow}>
                <span style={s.colVendor}>{v.vendorName}</span>
                <span style={s.col}>{v.totalLeads}</span>
                <span style={s.col}>{v.untouched}</span>
                <span style={s.col}>{pct(v.contactRate)}</span>
                <span style={s.col}>{pct(v.quoteRate)}</span>
                <span style={s.col}>{pct(v.closeRate)}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section style={s.section}>
        <SectionHeader>By Lead Type / Product</SectionHeader>
        {(productBreakdown || []).length === 0 ? (
          <EmptyState title="No leads this period" description="Nothing to break down by product yet for this date range." />
        ) : (
          <Card style={s.tableCard}>
            <div style={s.tableHeaderRow}>
              <span style={s.colVendor}>PRODUCT</span>
              <span style={s.col}>LEADS</span>
              <span style={s.col}>CONTACT%</span>
              <span style={s.col}>QUOTE%</span>
              <span style={s.col}>CLOSE%</span>
              <span style={s.col}>SALES</span>
            </div>
            {productBreakdown.map((p) => (
              <div key={p.product} style={s.tableRow}>
                <span style={s.colVendor}>{p.product}</span>
                <span style={s.col}>{p.totalLeads}</span>
                <span style={s.col}>{pct(p.contactRate)}</span>
                <span style={s.col}>{pct(p.quoteRate)}</span>
                <span style={s.col}>{pct(p.closeRate)}</span>
                <span style={s.col}>{p.salesCount}</span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </div>
  );
}

// Contact info, an AI coaching summary grounded in the real data already on
// this page, and freeform coaching notes — the "coaching helper" the user
// asked for, built as its own local sub-component so the main page above
// stays focused on the real performance numbers.
function CoachingHelperSection({ userId, user, onPhoneSaved }) {
  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState(user.phone || '');
  const [phoneBusy, setPhoneBusy] = useState(false);

  const [notes, setNotes] = useState(null);
  const [noteContent, setNoteContent] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [notesError, setNotesError] = useState('');

  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');

  useEffect(() => {
    loadNotes();
    loadSummary();
  }, [userId]);

  async function loadNotes() {
    setNotesError('');
    try {
      const res = await api.producerNotes(userId);
      setNotes(res.notes);
    } catch (err) {
      setNotesError(err.data?.message || 'Could not load coaching notes.');
    }
  }

  async function loadSummary() {
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const res = await api.coachingSummary(userId);
      setSummary(res);
    } catch (err) {
      setSummaryError(err.data?.message || 'Could not generate a coaching summary.');
    } finally {
      setSummaryLoading(false);
    }
  }

  async function savePhone() {
    setPhoneBusy(true);
    try {
      await onPhoneSaved(phoneDraft.trim());
      setEditingPhone(false);
    } finally {
      setPhoneBusy(false);
    }
  }

  async function addNote() {
    if (!noteContent.trim()) return;
    setNoteBusy(true);
    try {
      await api.createProducerNote(userId, noteContent.trim());
      setNoteContent('');
      await loadNotes();
    } catch (err) {
      setNotesError(err.data?.message || 'Could not save that note.');
    } finally {
      setNoteBusy(false);
    }
  }

  return (
    <Card style={s.section}>
      <SectionHeader>COACHING HELPER</SectionHeader>

      <div style={s.helperGrid}>
        <div>
          <div style={s.sectionLabel}>CONTACT INFO</div>
          <div style={s.contactRow}><span style={s.contactLabel}>Email</span><span>{user.email}</span></div>
          <div style={s.contactRow}>
            <span style={s.contactLabel}>Phone</span>
            {editingPhone ? (
              <div style={{ display: 'flex', gap: 6, flex: 1 }}>
                <input style={s.phoneInput} value={phoneDraft} onChange={(e) => setPhoneDraft(e.target.value)} placeholder="Phone number" autoFocus />
                <Button variant="primary" size="sm" disabled={phoneBusy} onClick={savePhone}>SAVE</Button>
                <Button variant="ghost" size="sm" onClick={() => { setEditingPhone(false); setPhoneDraft(user.phone || ''); }}>CANCEL</Button>
              </div>
            ) : (
              <>
                <span>{user.phone || <span style={s.noDataYet}>Not on file</span>}</span>
                <button style={s.editLink} onClick={() => setEditingPhone(true)}>EDIT</button>
              </>
            )}
          </div>
        </div>

        <div>
          <div style={s.sectionLabel}>AI COACHING SUMMARY</div>
          {summaryLoading ? (
            <div style={s.noDataYet}>Thinking it over…</div>
          ) : summaryError ? (
            <div style={s.summaryError}>{summaryError}</div>
          ) : summary ? (
            <div style={summary.available ? s.summaryBox : s.summaryBoxFallback}>{summary.message}</div>
          ) : null}
        </div>
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={s.sectionLabel}>COACHING NOTES ({notes?.length || 0})</div>
        <div style={s.noteForm}>
          <textarea style={s.noteInput} placeholder="Add a coaching note…" value={noteContent} onChange={(e) => setNoteContent(e.target.value)} />
          <MicButton onTranscript={(text) => setNoteContent((v) => (v ? `${v} ${text}` : text))} />
          <Button variant="secondary" size="sm" disabled={noteBusy || !noteContent.trim()} onClick={addNote}>ADD NOTE</Button>
        </div>
        {notesError && <div style={s.summaryError}>{notesError}</div>}
        {(notes || []).length === 0 ? (
          <div style={s.noDataYet}>No coaching notes yet.</div>
        ) : (
          <div style={s.notesList}>
            {notes.map((n) => (
              <div key={n.id} style={s.noteRow}>
                <div style={s.noteMeta}>{n.author?.firstName} {n.author?.lastName} · {new Date(n.createdAt).toLocaleString()}</div>
                <div style={s.noteContent}>{n.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 10 },
  h3: { color: 'var(--text-primary)', fontSize: 22, fontFamily: 'var(--font-display)', marginTop: 4 },
  periodRow: { display: 'flex', gap: 6 },
  periodBtn: (active) => ({
    padding: '8px 14px', borderRadius: 6, fontSize: 11, fontWeight: 700, letterSpacing: 0.3, cursor: 'pointer', border: 'none',
    background: active ? 'var(--accent-gradient)' : 'var(--bg-elevated)', color: active ? 'var(--accent-on)' : 'var(--text-secondary)',
  }),
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  section: { marginBottom: 24 },
  scoreRow: { display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' },
  driversWrap: { flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column', gap: 12 },
  sectionLabel: { color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 6 },
  driverRow: { display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--text-secondary)', padding: '4px 0' },
  driverValuePositive: { color: 'var(--accent)', fontWeight: 700 },
  driverValueNegative: { color: 'var(--warning)', fontWeight: 700 },
  noDataYet: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
  excludedNote: { color: 'var(--text-muted)', fontSize: 11, marginTop: 8, fontStyle: 'italic' },
  statsRow: { display: 'flex', gap: 32, flexWrap: 'wrap' },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  tableRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)' },
  colVendor: { fontWeight: 600 },
  col: { color: 'var(--text-secondary)' },
  helperGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 },
  contactRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-primary)', padding: '6px 0' },
  contactLabel: { color: 'var(--text-muted)', minWidth: 60 },
  phoneInput: { flex: 1, padding: '6px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13 },
  editLink: { marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--accent)', fontSize: 11, fontWeight: 700, cursor: 'pointer' },
  summaryBox: { padding: 12, background: 'var(--accent-gradient-soft)', border: '1px solid var(--border-accent)', borderRadius: 8, fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.5 },
  summaryBoxFallback: { padding: 12, background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)', fontStyle: 'italic', lineHeight: 1.5 },
  summaryError: { color: 'var(--danger)', fontSize: 12 },
  noteForm: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 },
  noteInput: { flex: 1, padding: '8px 10px', background: 'var(--bg-sunken)', border: '1px solid var(--border-strong)', borderRadius: 6, color: 'var(--text-primary)', fontSize: 13, minHeight: 44, fontFamily: 'inherit' },
  notesList: { display: 'flex', flexDirection: 'column', gap: 8 },
  noteRow: { padding: '8px 12px', background: 'var(--bg-sunken)', border: '1px solid var(--border-hairline)', borderRadius: 6 },
  noteMeta: { color: 'var(--text-muted)', fontSize: 11, marginBottom: 4 },
  noteContent: { color: 'var(--text-primary)', fontSize: 13 },
};
