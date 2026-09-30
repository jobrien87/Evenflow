// In development, Vite proxies /api to the local server (see vite.config.js).
// In production, the client and server are separate Render services, so we need
// the server's absolute URL, injected at build time via VITE_API_BASE_URL.
const BASE = `${import.meta.env.VITE_API_BASE_URL || ''}/api`;

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || 'Request failed');
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
  completeTour: () => request('/auth/complete-tour', { method: 'POST' }),
  completeFirstLoginCelebration: () => request('/auth/complete-first-login-celebration', { method: 'POST' }),
  acceptInvitation: (token, password) => request('/auth/accept-invitation', { method: 'POST', body: { token, password } }),
  forgotPassword: (email) => request('/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (token, password) => request('/auth/reset-password', { method: 'POST', body: { token, password } }),

  workQueue: () => request('/work-queue'),
  startMyDay: () => request('/start-my-day'),

  leads: (params = '') => request(`/leads${params}`),
  leadDetail: (id) => request(`/leads/${id}`),
  leadFunnel: (params = '') => request(`/leads/funnel${params}`),
  leadsSnapshot: (params = '') => request(`/leads/snapshot${params}`),
  zipReport: (params = '') => request(`/leads/zip-report${params}`),
  emailZipReport: (to, params = '') => request(`/leads/zip-report/email${params}`, { method: 'POST', body: { to } }),
  createLead: (payload) => request('/leads', { method: 'POST', body: payload }),
  dispositionLead: (id, payload) => request(`/leads/${id}/disposition`, { method: 'POST', body: payload }),
  moshpitLeads: () => request('/leads/moshpit'),
  claimLead: (id) => request(`/leads/${id}/claim`, { method: 'POST' }),
  logLeadActivity: (id, payload) => request(`/leads/${id}/activities`, { method: 'POST', body: payload }),
  createLeadNote: (id, content) => request(`/leads/${id}/notes`, { method: 'POST', body: { content } }),
  logProductQuote: (id, payload) => request(`/leads/${id}/products`, { method: 'POST', body: payload }),
  deleteProductQuote: (id, product) => request(`/leads/${id}/products/${product}`, { method: 'DELETE' }),

  tasks: (params = '') => request(`/tasks${params}`),
  createTask: (payload) => request('/tasks', { method: 'POST', body: payload }),
  completeTask: (id, payload) => request(`/tasks/${id}/complete`, { method: 'POST', body: payload }),

  myClockStatus: () => request('/timeclock/me'),
  clockIn: (agencyId) => request('/timeclock/clock-in', { method: 'POST', body: agencyId ? { agencyId } : {} }),
  clockOut: () => request('/timeclock/clock-out', { method: 'POST' }),
  lunchStart: () => request('/timeclock/lunch-start', { method: 'POST' }),
  lunchEnd: () => request('/timeclock/lunch-end', { method: 'POST' }),
  breakStart: () => request('/timeclock/break-start', { method: 'POST' }),
  breakEnd: () => request('/timeclock/break-end', { method: 'POST' }),
  setPresence: (status) => request('/timeclock/presence', { method: 'POST', body: { status } }),
  teamClockStatus: () => request('/timeclock/status'),
  timeClockReport: (params = '') => request(`/timeclock/report${params}`),

  pendingAnnouncement: () => request('/announcements/pending'),
  ackAnnouncement: (id) => request(`/announcements/${id}/ack`, { method: 'POST' }),
  createAnnouncement: (payload) => request('/announcements', { method: 'POST', body: payload }),
  // Not JSON — a multipart upload, same bypass-request() shape as uploadCall.
  bulkImportLeads: async (file, agencyId, leadCategory) => {
    const formData = new FormData();
    formData.append('file', file);
    if (agencyId) formData.append('agencyId', agencyId);
    formData.append('leadCategory', leadCategory);
    const res = await fetch(`${BASE}/leads/bulk-import`, { method: 'POST', credentials: 'include', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || 'Upload failed');
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  },

  agencies: (params = '') => request(`/agencies${params}`),
  createAgency: (payload) => request('/agencies', { method: 'POST', body: payload }),
  resendAgencyInvite: (agencyId) => request(`/agencies/${agencyId}/resend-invite`, { method: 'POST' }),
  agencyDetail: (agencyId) => request(`/agencies/${agencyId}`),
  agencyActivity: (agencyId, params = '') => request(`/agencies/${agencyId}/activity${params}`),
  updateAgency: (agencyId, payload) => request(`/agencies/${agencyId}`, { method: 'PATCH', body: payload }),
  updateAgencyEntitlements: (agencyId, payload) => request(`/agencies/${agencyId}/entitlements`, { method: 'PATCH', body: payload }),
  inviteAgencyOwner: (agencyId, payload) => request(`/agencies/${agencyId}/invite-owner`, { method: 'POST', body: payload }),

  users: (params = '') => request(`/users${params}`),
  inviteUser: (payload) => request('/users/invite', { method: 'POST', body: payload }),
  inviteUsersBulk: (invites) => request('/users/invite-bulk', { method: 'POST', body: { invites } }),

  // Personalize page — every user's own account.
  myBackgroundUrl: () => `${BASE}/users/me/background`,
  // Not JSON — a multipart upload, same bypass-request() shape as uploadCall.
  uploadBackgroundImage: async (file) => {
    const formData = new FormData();
    formData.append('image', file);
    const res = await fetch(`${BASE}/users/me/background`, { method: 'POST', credentials: 'include', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || 'Upload failed');
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  },
  deleteBackgroundImage: () => request('/users/me/background', { method: 'DELETE' }),
  updatePersonalization: (payload) => request('/users/me/personalize', { method: 'PATCH', body: payload }),
  updateUser: (userId, payload) => request(`/users/${userId}`, { method: 'PATCH', body: payload }),
  deactivateUser: (userId) => request(`/users/${userId}/deactivate`, { method: 'POST' }),
  resendUserInvite: (userId) => request(`/users/${userId}/resend-invite`, { method: 'POST' }),
  sendPasswordReset: (userId) => request(`/users/${userId}/send-password-reset`, { method: 'POST' }),
  userPerformance: (userId, params = '') => request(`/users/${userId}/performance${params}`),
  producerNotes: (userId) => request(`/users/${userId}/notes`),
  createProducerNote: (userId, content) => request(`/users/${userId}/notes`, { method: 'POST', body: { content } }),
  coachingSummary: (userId, humorLevel) => request(`/ed/coaching-summary?userId=${userId}${humorLevel ? `&humorLevel=${humorLevel}` : ''}`),

  telemarketers: () => request('/telemarketers'),
  telemarketerAgencyRoster: (params = '') => request(`/telemarketers/agency-roster${params}`),
  telemarketerPerformance: (params = '') => request(`/telemarketers/performance${params}`),
  myAssignments: () => request('/telemarketers/me/assignments'),
  inviteTelemarketer: (payload) => request('/telemarketers/invite', { method: 'POST', body: payload }),
  assignTelemarketer: (payload) => request('/telemarketers/assign', { method: 'POST', body: payload }),
  endAssignment: (id) => request(`/telemarketers/assignments/${id}/end`, { method: 'POST' }),
  resendTelemarketerInvite: (id) => request(`/telemarketers/${id}/resend-invite`, { method: 'POST' }),

  // Read-only — the Transfer accept/reject/routing/credit-request
  // workflow was retired (telemarketer submissions are real Leads now,
  // see createLead); historical Transfer data stays inspectable.
  transfers: (params = '') => request(`/transfers${params}`),
  transferDetail: (id) => request(`/transfers/${id}`),

  vendors: (params = '') => request(`/vendors${params}`),
  createVendor: (payload) => request('/vendors', { method: 'POST', body: payload }),
  vendorDetail: (id) => request(`/vendors/${id}`),
  rotateVendorCredential: (id) => request(`/vendors/${id}/rotate-credential`, { method: 'POST' }),
  revokeVendorCredential: (id) => request(`/vendors/${id}/revoke-credential`, { method: 'POST' }),
  setVendorStatus: (id, status) => request(`/vendors/${id}/status`, { method: 'PATCH', body: { status } }),
  updateVendor: (id, payload) => request(`/vendors/${id}`, { method: 'PATCH', body: payload }),
  vendorTransactions: (id) => request(`/vendors/${id}/transactions`),

  offices: (params = '') => request(`/offices${params}`),
  createOffice: (payload) => request('/offices', { method: 'POST', body: payload }),
  updateOffice: (id, payload) => request(`/offices/${id}`, { method: 'PATCH', body: payload }),
  deleteOffice: (id) => request(`/offices/${id}`, { method: 'DELETE' }),

  financialSummary: (params = '') => request(`/financials/summary${params}`),
  financialByVendor: (params = '') => request(`/financials/by-vendor${params}`),
  financialByAgent: (params = '') => request(`/financials/by-agent${params}`),
  financialEvents: (params = '') => request(`/financials/events${params}`),
  createRevenueEvent: (payload) => request('/financials/revenue-events', { method: 'POST', body: payload }),
  createCostEvent: (payload) => request('/financials/cost-events', { method: 'POST', body: payload }),

  myFlowScore: () => request('/flow-score/me'),
  userFlowScore: (userId) => request(`/flow-score/user/${userId}`),
  agencyFlowScore: (agencyId) => request(`/flow-score/agency/${agencyId}`),
  flowScoreHistory: (subjectType, subjectId) => request(`/flow-score/history?subjectType=${subjectType}&subjectId=${subjectId}`),

  edStatus: () => request('/ed/status'),
  edAsk: (message, humorLevel) => request('/ed/ask', { method: 'POST', body: { message, humorLevel } }),
  edBriefing: (humorLevel) => request(`/ed/briefing${humorLevel ? `?humorLevel=${humorLevel}` : ''}`),
  edHistory: () => request('/ed/history'),
  edSuggest: (pageContext, humorLevel) => request('/ed/suggest', { method: 'POST', body: { pageContext, humorLevel } }),
  edEscalate: (subject, description) => request('/ed/escalate', { method: 'POST', body: { subject, description } }),
  edUsageSummary: () => request('/ed/usage-summary'),

  supportTickets: (params = '') => request(`/support${params}`),
  createSupportTicket: (payload) => request('/support', { method: 'POST', body: payload }),
  setSupportTicketStatus: (id, status) => request(`/support/${id}/status`, { method: 'PATCH', body: { status } }),

  calls: (params = '') => request(`/calls${params}`),
  callDetail: (id) => request(`/calls/${id}`),
  retryCall: (id) => request(`/calls/${id}/retry`, { method: 'POST' }),
  submitCallTranscript: (id, transcript) => request(`/calls/${id}/transcript`, { method: 'PATCH', body: { transcript } }),
  // Not a JSON call — used directly as an <audio crossOrigin="use-credentials" src=...>
  // so the session cookie rides along even when client/server are on separate origins.
  callAudioUrl: (id) => `${BASE}/calls/${id}/audio`,
  reviewCall: (id, payload) => request(`/calls/${id}/review`, { method: 'POST', body: payload }),
  coachingBreakdown: (params = '') => request(`/calls/coaching${params}`),
  uploadCall: async (file, leadId, producerId) => {
    const formData = new FormData();
    formData.append('recording', file);
    if (leadId) formData.append('leadId', leadId);
    if (producerId) formData.append('producerId', producerId);
    const res = await fetch(`${BASE}/calls`, { method: 'POST', credentials: 'include', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || 'Upload failed');
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  },

  billingStatus: () => request('/billing/status'),
  plans: () => request('/billing/plans'),
  createPlan: (payload) => request('/billing/plans', { method: 'POST', body: payload }),
  updatePlan: (id, payload) => request(`/billing/plans/${id}`, { method: 'PATCH', body: payload }),
  agencySubscription: (agencyId) => request(`/billing/agencies/${agencyId}/subscription`),
  assignSubscription: (agencyId, payload) => request(`/billing/agencies/${agencyId}/subscription`, { method: 'POST', body: payload }),
  cancelSubscription: (agencyId) => request(`/billing/agencies/${agencyId}/subscription/cancel`, { method: 'POST' }),
  selfServeBillingStatus: () => request('/billing/self-serve/status'),
  startSelfServeCheckout: () => request('/billing/self-serve/checkout', { method: 'POST' }),
  openBillingPortal: () => request('/billing/self-serve/portal', { method: 'POST' }),

  trainingCourses: () => request('/training/courses'),
  trainingCourse: (id) => request(`/training/courses/${id}`),
  createTrainingCourse: (payload) => request('/training/courses', { method: 'POST', body: payload }),
  updateTrainingCourse: (id, payload) => request(`/training/courses/${id}`, { method: 'PATCH', body: payload }),
  addTrainingLesson: (courseId, payload) => request(`/training/courses/${courseId}/lessons`, { method: 'POST', body: payload }),
  assignTraining: (payload) => request('/training/assign', { method: 'POST', body: payload }),
  myTrainingAssignments: () => request('/training/my-assignments'),
  teamTrainingAssignments: () => request('/training/assignments'),
  completeLesson: (lessonId, payload) => request(`/training/lessons/${lessonId}/complete`, { method: 'POST', body: payload }),
  recommendedTraining: () => request('/training/recommended'),
  roleplayMessage: (lessonId, messages) => request(`/roleplay/${lessonId}/message`, { method: 'POST', body: { messages } }),

  notifications: () => request('/notifications'),
  unreadNotificationCount: () => request('/notifications/unread-count'),
  markNotificationRead: (id) => request(`/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () => request('/notifications/read-all', { method: 'POST' }),
  notificationPreferences: () => request('/notifications/preferences'),
  updateNotificationPreferences: (payload) => request('/notifications/preferences', { method: 'PATCH', body: payload }),

  opportunities: (params = '') => request(`/opportunities${params}`),
  createWinback: (payload) => request('/opportunities/winback', { method: 'POST', body: payload }),
  dispositionOpportunity: (id, payload) => request(`/opportunities/${id}/disposition`, { method: 'POST', body: payload }),
  searchCustomers: (q) => request(`/customers/search?q=${encodeURIComponent(q)}`),
  customerDetail: (id) => request(`/customers/${id}`),

  goals: (params = '') => request(`/goals${params}`),
  createGoal: (payload) => request('/goals', { method: 'POST', body: payload }),
  updateGoal: (id, payload) => request(`/goals/${id}`, { method: 'PATCH', body: payload }),
  deleteGoal: (id) => request(`/goals/${id}`, { method: 'DELETE' }),
  parseGoal: (text) => request('/goals/parse', { method: 'POST', body: { text } }),

  myRunningReport: () => request('/running-report/me'),
  agencyRunningReport: (agencyId) => request(`/running-report/agency/${agencyId}`),

  chatConversations: () => request('/chat/conversations'),
  chatEntityConversation: (entityType, entityId) => request(`/chat/conversations/entity/${entityType}/${entityId}`),
  chatMessages: (conversationId) => request(`/chat/conversations/${conversationId}/messages`),
  postChatMessage: (conversationId, content) => request(`/chat/conversations/${conversationId}/messages`, { method: 'POST', body: { content } }),

  impersonationStatus: () => request('/impersonation/status'),
  startImpersonation: (targetUserId) => request('/impersonation/start', { method: 'POST', body: { targetUserId } }),
  endImpersonation: () => request('/impersonation/end', { method: 'POST' }),
  searchUsersForImpersonation: (q) => request(`/impersonation/search-users?q=${encodeURIComponent(q)}`),
};
