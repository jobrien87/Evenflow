// Single source of truth for every section the Main Stage dashboard
// (AgencyOwnerDashboard.jsx) can show, and every toggle the Personalize
// page's "Main Stage Dashboard" section offers for it. Both read this
// same array so they can never drift out of sync.
//
// `defaultVisible: true` on every entry encodes "today's dashboard,
// unmodified, is what a user with no saved preference sees" — an empty
// User.hiddenDashboardWidgets means show everything, so there is no
// special-case default logic anywhere else.
//
// Groups must stay contiguous in this array's own order — the
// Personalize page clusters adjacent same-group entries without a
// second sort.
export const DASHBOARD_WIDGETS = [
  // --- Performance & Flow ---
  { key: 'agencyFlowScore', label: 'Agency Flow Score', group: 'Performance & Flow', component: 'FlowScoreCard', defaultVisible: true },
  { key: 'leadsSnapshot', label: 'Leads Snapshot', group: 'Performance & Flow', component: 'LeadsSnapshotBox', defaultVisible: true },
  { key: 'agencyFunnel', label: 'Agency Funnel', group: 'Performance & Flow', component: 'FunnelMetricsCard', defaultVisible: true },
  { key: 'zipCodePerformance', label: 'Zip Code Performance', group: 'Performance & Flow', component: 'ZipCodeBox', defaultVisible: true },
  { key: 'performanceLeaderboards', label: 'Performance Leaderboards', group: 'Performance & Flow', component: 'PerformanceLeaderboards', defaultVisible: true },
  { key: 'billboardSnapshot', label: 'Billboard', group: 'Performance & Flow', component: 'BillboardPanel', defaultVisible: true },
  { key: 'agencyCoachingBreakdown', label: 'Call Coaching Breakdown', group: 'Performance & Flow', component: 'AgencyCoachingBreakdownBox', defaultVisible: true },
  { key: 'agencyFlowScoreBreakdown', label: 'Flow Score — Full Breakdown', group: 'Performance & Flow', component: 'FlowScoreBreakdownCard', defaultVisible: true },

  // --- Team & Operations ---
  { key: 'teamClockStatus', label: 'Team Clock Status', group: 'Team & Operations', component: 'TeamClockStatusBox', defaultVisible: true },
  { key: 'officesManagement', label: 'Offices', group: 'Team & Operations', component: '(inline OFFICES section)', defaultVisible: true },
  { key: 'teamRoster', label: 'Team Roster', group: 'Team & Operations', component: '(inline TEAM section)', defaultVisible: true },
  { key: 'telemarketersRoster', label: 'Telemarketers', group: 'Team & Operations', component: '(inline TELEMARKETERS section)', defaultVisible: true },
  { key: 'moshpitSnapshot', label: 'Moshpit Pool', group: 'Team & Operations', component: 'MoshpitPanel', defaultVisible: true },
  { key: 'workAnniversaries', label: 'Upcoming Work Anniversaries', group: 'Team & Operations', component: 'WorkAnniversariesBox', defaultVisible: true },
  { key: 'trainingRollup', label: 'Training Completion', group: 'Team & Operations', component: 'TrainingRollupBox', defaultVisible: true },
  { key: 'breakRoomEngagement', label: 'Break Room Engagement', group: 'Team & Operations', component: 'BreakRoomEngagementBox', defaultVisible: true },

  // --- Pipeline Snapshots ---
  { key: 'leadSearch', label: 'Lead Search', group: 'Pipeline Snapshots', component: 'LeadSearchBox', defaultVisible: true },
  { key: 'winbacksOpportunities', label: 'Winbacks & Cross-Sell', group: 'Pipeline Snapshots', component: 'OpportunitiesPanel', defaultVisible: true },
  { key: 'appointments', label: 'Appointments', group: 'Pipeline Snapshots', component: 'AppointmentsBox', defaultVisible: true },
  { key: 'closedSalesRecent', label: 'Recent Closed Sales', group: 'Pipeline Snapshots', component: 'ClosedSalesPanel', defaultVisible: true },
  { key: 'goalsPacing', label: 'Goals & Pacing', group: 'Pipeline Snapshots', component: 'GoalsPanel', defaultVisible: true },
  { key: 'financialsSummary', label: 'Financials Summary', group: 'Pipeline Snapshots', component: 'FinancialsPanel', defaultVisible: true, roles: ['AGENCY_OWNER'] },

  // --- Communication ---
  { key: 'edSuggestion', label: 'Ed Suggests', group: 'Communication', component: 'EdSuggestionBox', defaultVisible: true },
  { key: 'teamChatInline', label: 'Team Chat', group: 'Communication', component: 'ChatThread', defaultVisible: true },
  { key: 'activityFeed', label: 'Agency Activity Feed', group: 'Communication', component: 'AgencyActivityFeedBox', defaultVisible: true },
];

export const DASHBOARD_WIDGET_GROUPS = [
  'Performance & Flow',
  'Team & Operations',
  'Pipeline Snapshots',
  'Communication',
];

// A widget is visible if the user hasn't hidden its key AND (it has no
// role restriction OR the current role is in that restriction). The role
// check exists today only for financialsSummary — Financials is already
// Owner-only at the route/server level, so an Agency Manager should never
// even be offered a toggle that would just 403 if turned on.
export function isWidgetVisible(key, user) {
  const widget = DASHBOARD_WIDGETS.find((w) => w.key === key);
  if (!widget) return true; // unknown/retired key never hides anything
  if (widget.roles && !widget.roles.includes(user?.role)) return false;
  return !(user?.hiddenDashboardWidgets || []).includes(key);
}

export function widgetsForRole(user) {
  return DASHBOARD_WIDGETS.filter((w) => !w.roles || w.roles.includes(user?.role));
}
