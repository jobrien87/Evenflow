function buildCustomerTimeline({ leads, transfers, calls, opportunities }) {
  const entries = [];

  for (const lead of leads || []) {
    entries.push({ at: lead.createdAt, type: 'lead.created', label: `Lead received via ${lead.source}`, refType: 'Lead', refId: lead.id });
    for (const evt of lead.events || []) {
      entries.push({ at: evt.createdAt, type: `lead.${evt.type}`, label: evt.toStatus ? `Lead status: ${evt.toStatus}` : evt.type, refType: 'Lead', refId: lead.id });
    }
  }

  for (const transfer of transfers || []) {
    entries.push({ at: transfer.createdAt, type: 'transfer.created', label: `Transfer submitted — ${transfer.product}`, refType: 'Transfer', refId: transfer.id });
    for (const evt of transfer.events || []) {
      entries.push({ at: evt.createdAt, type: `transfer.${evt.toStatus}`, label: `Transfer: ${evt.toStatus}${evt.reason ? ` — ${evt.reason}` : ''}`, refType: 'Transfer', refId: transfer.id });
    }
  }

  for (const call of calls || []) {
    entries.push({ at: call.createdAt, type: 'call.uploaded', label: `Call uploaded: ${call.filename}`, refType: 'Call', refId: call.id });
    if (call.status === 'COMPLETE') {
      entries.push({ at: call.updatedAt, type: 'call.analyzed', label: `Call analyzed — score ${call.analysis ? call.analysis.overallScore : '?'}`, refType: 'Call', refId: call.id });
    }
  }

  for (const opp of opportunities || []) {
    entries.push({ at: opp.createdAt, type: `opportunity.${opp.type.toLowerCase()}_created`, label: `${opp.type === 'WINBACK' ? 'Winback' : 'Cross-sell'} opportunity: ${opp.product}`, refType: 'Opportunity', refId: opp.id });
    for (const evt of opp.events || []) {
      entries.push({ at: evt.createdAt, type: `opportunity.${evt.toStatus}`, label: `Opportunity: ${evt.toStatus}`, refType: 'Opportunity', refId: opp.id });
    }
  }

  entries.sort((a, b) => new Date(a.at) - new Date(b.at));
  return entries;
}

module.exports = { buildCustomerTimeline };
