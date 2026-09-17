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

  workQueue: () => request('/work-queue'),
  startMyDay: () => request('/start-my-day'),

  leads: (params = '') => request(`/leads${params}`),
  createLead: (payload) => request('/leads', { method: 'POST', body: payload }),
  dispositionLead: (id, payload) => request(`/leads/${id}/disposition`, { method: 'POST', body: payload }),

  completeTask: (id, payload) => request(`/tasks/${id}/complete`, { method: 'POST', body: payload }),

  agencies: () => request('/agencies'),
  createAgency: (payload) => request('/agencies', { method: 'POST', body: payload }),
  updateTransferSettings: (agencyId, payload) => request(`/agencies/${agencyId}/transfer-settings`, { method: 'PATCH', body: payload }),
  resendAgencyInvite: (agencyId) => request(`/agencies/${agencyId}/resend-invite`, { method: 'POST' }),

  users: (params = '') => request(`/users${params}`),
  inviteUser: (payload) => request('/users/invite', { method: 'POST', body: payload }),
  deactivateUser: (userId) => request(`/users/${userId}/deactivate`, { method: 'POST' }),
  resendUserInvite: (userId) => request(`/users/${userId}/resend-invite`, { method: 'POST' }),

  telemarketers: () => request('/telemarketers'),
  myAssignments: () => request('/telemarketers/me/assignments'),
  inviteTelemarketer: (payload) => request('/telemarketers/invite', { method: 'POST', body: payload }),
  assignTelemarketer: (payload) => request('/telemarketers/assign', { method: 'POST', body: payload }),
  endAssignment: (id) => request(`/telemarketers/assignments/${id}/end`, { method: 'POST' }),
  resendTelemarketerInvite: (id) => request(`/telemarketers/${id}/resend-invite`, { method: 'POST' }),

  transfers: (params = '') => request(`/transfers${params}`),
  createTransfer: (payload) => request('/transfers', { method: 'POST', body: payload }),
  acceptTransfer: (id) => request(`/transfers/${id}/accept`, { method: 'POST' }),
  rejectTransfer: (id, reason) => request(`/transfers/${id}/reject`, { method: 'POST', body: { reason } }),
  connectTransfer: (id) => request(`/transfers/${id}/connect`, { method: 'POST' }),
  completeTransfer: (id) => request(`/transfers/${id}/complete`, { method: 'POST' }),
  dispositionTransfer: (id, payload) => request(`/transfers/${id}/disposition`, { method: 'POST', body: payload }),
  requestCredit: (id, payload) => request(`/transfers/${id}/credit-request`, { method: 'POST', body: payload }),
  creditRequests: (params = '') => request(`/transfers/credit-requests${params}`),
  decideCredit: (id, payload) => request(`/transfers/credit-requests/${id}/decide`, { method: 'POST', body: payload }),

  vendors: (params = '') => request(`/vendors${params}`),
  createVendor: (payload) => request('/vendors', { method: 'POST', body: payload }),
  vendorDetail: (id) => request(`/vendors/${id}`),
  rotateVendorCredential: (id) => request(`/vendors/${id}/rotate-credential`, { method: 'POST' }),
  revokeVendorCredential: (id) => request(`/vendors/${id}/revoke-credential`, { method: 'POST' }),
  setVendorStatus: (id, status) => request(`/vendors/${id}/status`, { method: 'PATCH', body: { status } }),
  vendorTransactions: (id) => request(`/vendors/${id}/transactions`),

  financialSummary: (params = '') => request(`/financials/summary${params}`),
  financialByVendor: (params = '') => request(`/financials/by-vendor${params}`),
  createRevenueEvent: (payload) => request('/financials/revenue-events', { method: 'POST', body: payload }),
  createCostEvent: (payload) => request('/financials/cost-events', { method: 'POST', body: payload }),

  myFlowScore: () => request('/flow-score/me'),
  userFlowScore: (userId) => request(`/flow-score/user/${userId}`),
  agencyFlowScore: (agencyId) => request(`/flow-score/agency/${agencyId}`),
  flowScoreHistory: (subjectType, subjectId) => request(`/flow-score/history?subjectType=${subjectType}&subjectId=${subjectId}`),

  edStatus: () => request('/ed/status'),
  edAsk: (message, humorLevel) => request('/ed/ask', { method: 'POST', body: { message, humorLevel } }),
  edHistory: () => request('/ed/history'),
  edEscalate: (subject, description) => request('/ed/escalate', { method: 'POST', body: { subject, description } }),
  edUsageSummary: () => request('/ed/usage-summary'),

  supportTickets: (params = '') => request(`/support${params}`),
  createSupportTicket: (payload) => request('/support', { method: 'POST', body: payload }),
  setSupportTicketStatus: (id, status) => request(`/support/${id}/status`, { method: 'PATCH', body: { status } }),

  calls: (params = '') => request(`/calls${params}`),
  callDetail: (id) => request(`/calls/${id}`),
  retryCall: (id) => request(`/calls/${id}/retry`, { method: 'POST' }),
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
  deleteGoal: (id) => request(`/goals/${id}`, { method: 'DELETE' }),

  impersonationStatus: () => request('/impersonation/status'),
  startImpersonation: (targetUserId) => request('/impersonation/start', { method: 'POST', body: { targetUserId } }),
  endImpersonation: () => request('/impersonation/end', { method: 'POST' }),
  searchUsersForImpersonation: (q) => request(`/impersonation/search-users?q=${encodeURIComponent(q)}`),
};
