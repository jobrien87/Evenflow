import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, Button, SectionHeader, MicButton } from '../ui';

// Contact info, an AI coaching summary grounded in real data, and freeform
// coaching notes — shared by ProducerDetailPage (the regular performance
// profile) and CallScoringProfilePage (the deeper Call Scoring profile),
// so there's one real notes/summary surface per producer, not two
// divergent copies living on two different pages.
export default function CoachingHelperSection({ userId, user, onPhoneSaved }) {
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
  section: { marginBottom: 24 },
  sectionLabel: { color: 'var(--text-muted)', fontSize: 10, fontWeight: 700, letterSpacing: 1, marginBottom: 6 },
  noDataYet: { color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12 },
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
