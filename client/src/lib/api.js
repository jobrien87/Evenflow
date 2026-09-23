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
  acceptInvitation: (token, password) => request('/auth/accept-invitation', { method: 'POST', body: { token, password } }),
  forgotPassword: (email) => request('/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (token, password) => request('/auth/reset-password', { method: 'POST', body: { token, password } }),

  workQueue: () => request('/work-queue'),
  startMyDay: () => request('/start-my-day'),

  leads: (params = '') => request(`/leads${params}`),
  leadFunnel: (params = '') => request(`/leads/funnel${params}`),
  createLead: (payload) => request('/leads', { method: 'POST', body: payload }),
  dispositionLead: (id, payload) => request(`/leads/${id}/disposition`, { method: 'POST', body: payload }),

  completeTask: (id, payload) => request(`/tasks/${id}/complete`, { method: 'POST', body: payload }),

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
  updateUser: (userId, payload) => request(`/users/${userId}`, { method: 'PATCH', body: payload }),
  deactivateUser: (userId) => request(`/users/${userId}/deactivate`, { method: 'POST' }),
  resendUserInvite: (userId) => request(`/users/${userId}/resend-invite`, { method: 'POST' }),

  telemarketers: () => request('/telemarketers'),
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
  uploadCall: async (file, leadId) => {
    const formData = new FormData();
    formData.append('recording', file);
    if (leadId) formData.append('leadId', leadId);
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

  trainingCourses: () => request('/training/courses'),
  createTrainingCourse: (payload) => request('/training/courses', { method: 'POST', body: payload }),
  updateTrainingCourse: (id, payload) => request(`/training/courses/${id}`, { method: 'PATCH', body: payload }),
  addTrainingLesson: (courseId, payload) => request(`/training/courses/${courseId}/lessons`, { method: 'POST', body: payload }),
  assignTraining: (payload) => request('/training/assign', { method: 'POST', body: payload }),
  myTrainingAssignments: () => request('/training/my-assignments'),
  teamTrainingAssignments: () => request('/training/assignments'),
  completeLesson: (lessonId, payload) => request(`/training/lessons/${lessonId}/complete`, { method: 'POST', body: payload }),
  recommendedTraining: () => request('/training/recommended'),

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
