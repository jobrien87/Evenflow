import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Card, Badge, Button, SectionHeader, StatTile, DateRangeFilter, EmptyState } from '../ui';
import { resolveDateRange } from '../lib/dateRange';
import CoachingHelperSection from './CoachingHelperSection';
import FlowScoreSummaryCard from './FlowScoreSummaryCard';

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
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    load();
  }, [periodKey, customFrom, customTo, userId]);

  async function load() {
    const range = resolveDateRange(periodKey, PERIODS, customFrom, customTo);
    if (!range) return; // custom selected, dates not both picked yet
    setError('');
    try {
      const res = await api.userPerformance(userId, `?from=${range.from}&to=${range.to}`);
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
        <DateRangeFilter
          presets={PERIODS.map((p) => ({ key: p.key, label: p.label.toUpperCase() }))}
          periodKey={periodKey}
          onSelectPreset={setPeriodKey}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFromChange={setCustomFrom}
          onCustomToChange={setCustomTo}
        />
      </div>

      <FlowScoreSummaryCard snapshot={snapshot} explanation={explanation} componentPlaceholders={componentPlaceholders} />

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

const s = {
  wrap: {},
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, flexWrap: 'wrap', gap: 10 },
  h3: { color: 'var(--text-primary)', fontSize: 22, fontFamily: 'var(--font-display)', marginTop: 4 },
  loadErrorBox: { background: 'var(--danger-soft)', border: '1px solid rgba(255, 77, 94, 0.4)', color: 'var(--danger)', padding: 16, borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  retryButton: { padding: '6px 12px', background: 'var(--accent)', border: 'none', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11 },
  section: { marginBottom: 24 },
  statsRow: { display: 'flex', gap: 32, flexWrap: 'wrap' },
  tableCard: { padding: 0, overflow: 'hidden' },
  tableHeaderRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 10, letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-hairline)' },
  tableRow: { display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', padding: '10px 16px', fontSize: 12, color: 'var(--text-primary)', borderBottom: '1px solid var(--border-hairline)' },
  colVendor: { fontWeight: 600 },
  col: { color: 'var(--text-secondary)' },
};
