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
  mfaVerifyLogin: (challengeToken, code) => request('/auth/mfa/verify', { method: 'POST', body: { challengeToken, code } }),
  mfaEnroll: () => request('/auth/mfa/enroll', { method: 'POST' }),
  mfaConfirm: (code) => request('/auth/mfa/confirm', { method: 'POST', body: { code } }),
  mfaDisable: (password, code) => request('/auth/mfa/disable', { method: 'POST', body: { password, code } }),

  workQueue: () => request('/work-queue'),
  startMyDay: () => request('/start-my-day'),

  leads: (params = '') => request(`/leads${params}`),
  searchLeads: (params = '') => request(`/leads/search${params}`),
  leadDetail: (id) => request(`/leads/${id}`),
  leadFunnel: (params = '') => request(`/leads/funnel${params}`),
  leadsSnapshot: (params = '') => request(`/leads/snapshot${params}`),
  zipReport: (params = '') => request(`/leads/zip-report${params}`),
  emailZipReport: (to, params = '') => request(`/leads/zip-report/email${params}`, { method: 'POST', body: { to } }),
  createLead: (payload) => request('/leads', { method: 'POST', body: payload }),
  dispositionLead: (id, payload) => request(`/leads/${id}/disposition`, { method: 'POST', body: payload }),
  moshpitLeads: () => request('/leads/moshpit'),
  claimLead: (id) => request(`/leads/${id}/claim`, { method: 'POST' }),
  reassignLead: (id, assignedToId) => request(`/leads/${id}/reassign`, { method: 'POST', body: { assignedToId } }),
  logLeadActivity: (id, payload) => request(`/leads/${id}/activities`, { method: 'POST', body: payload }),
  createLeadNote: (id, content) => request(`/leads/${id}/notes`, { method: 'POST', body: { content } }),
  logProductQuote: (id, payload) => request(`/leads/${id}/products`, { method: 'POST', body: payload }),
  deleteProductQuote: (id, product) => request(`/leads/${id}/products/${product}`, { method: 'DELETE' }),

  // Add Closed Sale — standalone sales with no originating Lead in Evenflow.
  checkSaleDuplicate: (payload) => request('/sales/check-duplicate', { method: 'POST', body: payload }),
  createSale: (payload) => request('/sales', { method: 'POST', body: payload }),
  sales: (params = '') => request(`/sales${params}`),
  updateSale: (id, payload) => request(`/sales/${id}`, { method: 'PATCH', body: payload }),
  voidSale: (id, voidReason) => request(`/sales/${id}/void`, { method: 'POST', body: { voidReason } }),

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
  bulkImportLeads: async (file, agencyId, leadCategory, distribution = {}) => {
    const formData = new FormData();
    formData.append('file', file);
    if (agencyId) formData.append('agencyId', agencyId);
    formData.append('leadCategory', leadCategory);
    if (distribution.mode) formData.append('distributionMode', distribution.mode);
    if (distribution.selectedAgentIds) formData.append('selectedAgentIds', JSON.stringify(distribution.selectedAgentIds));
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
  leadImportBatches: (params = '') => request(`/leads/import-batches${params}`),
  undoLeadImport: (batchId) => request(`/leads/import-batches/${batchId}/undo`, { method: 'POST' }),

  // Back Catalog — historical data port-in from an external system
  // (Performology/AgencyZoom/Ricochet/other). Same bypass-request() shape
  // as bulkImportLeads, just a different endpoint/field set.
  backCatalogImport: async (file, agencyId, sourceSystem, leadCategory) => {
    const formData = new FormData();
    formData.append('file', file);
    if (agencyId) formData.append('agencyId', agencyId);
    formData.append('sourceSystem', sourceSystem);
    formData.append('leadCategory', leadCategory);
    const res = await fetch(`${BASE}/leads/back-catalog-import`, { method: 'POST', credentials: 'include', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || 'Upload failed');
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  },

  // Historical Data — numbers-only backfill (never a workable Lead, never
  // assigned, never notified). Same multipart shape as backCatalogImport,
  // just the dedicated endpoint/field set — no leadCategory, since these
  // rows feed report totals, not a worked lead queue.
  historicalDataImport: async (file, agencyId, sourceSystem) => {
    const formData = new FormData();
    formData.append('file', file);
    if (agencyId) formData.append('agencyId', agencyId);
    formData.append('sourceSystem', sourceSystem);
    const res = await fetch(`${BASE}/leads/historical-data-import`, { method: 'POST', credentials: 'include', body: formData });
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
  agencyFactoryResetPreview: (agencyId) => request(`/agencies/${agencyId}/factory-reset-preview`),
  agencyFactoryReset: (agencyId, confirmText) => request(`/agencies/${agencyId}/factory-reset`, { method: 'POST', body: { confirmText } }),

  users: (params = '') => request(`/users${params}`),
  inviteUser: (payload) => request('/users/invite', { method: 'POST', body: payload }),
  inviteUsersBulk: (invites) => request('/users/invite-bulk', { method: 'POST', body: { invites } }),

  // Record Store — wholesale lead marketplace (Boberdoo-backed).
  recordStoreTemplates: () => request('/record-store/templates'),
  recordStoreSubscriptions: (params = '') => request(`/record-store/subscriptions${params}`),
  recordStoreBalance: (params = '') => request(`/record-store/balance${params}`),
  recordStoreActivity: (params = '') => request(`/record-store/activity${params}`),
  createRecordStoreOrder: (payload) => request('/record-store/orders', { method: 'POST', body: payload }),
  provisionRecordStoreOrder: (id) => request(`/record-store/orders/${id}/provision`, { method: 'POST' }),
  confirmRecordStoreFunding: (id) => request(`/record-store/orders/${id}/confirm-funding`, { method: 'POST' }),
  pauseRecordStoreSubscription: (id) => request(`/record-store/subscriptions/${id}/pause`, { method: 'POST' }),
  resumeRecordStoreSubscription: (id) => request(`/record-store/subscriptions/${id}/resume`, { method: 'POST' }),
  changeRecordStoreVolume: (id, dailyVolume) => request(`/record-store/subscriptions/${id}/volume`, { method: 'POST', body: { dailyVolume } }),
  pauseRecordStoreAccount: (params = '') => request(`/record-store/account/pause-all${params}`, { method: 'POST' }),
  resumeRecordStoreAccount: (params = '') => request(`/record-store/account/resume-all${params}`, { method: 'POST' }),
  // Super Admin control center.
  adminRecordStoreTemplates: () => request('/record-store/admin/templates'),
  updateRecordStoreTemplate: (id, patch) => request(`/record-store/admin/templates/${id}`, { method: 'PATCH', body: patch }),
  adminRecordStoreCustomers: () => request('/record-store/admin/customers'),
  linkBoberdooPartner: (agencyId, partnerId) => request(`/record-store/admin/agencies/${agencyId}/link-partner`, { method: 'POST', body: { partnerId } }),
  syncRecordStoreAgency: (agencyId) => request(`/record-store/admin/agencies/${agencyId}/sync`, { method: 'POST' }),
  retryRecordStoreProvisioning: (id) => request(`/record-store/admin/subscriptions/${id}/retry`, { method: 'POST' }),
  adminPauseRecordStoreAccount: (agencyId) => request(`/record-store/admin/agencies/${agencyId}/pause-account`, { method: 'POST' }),
  adminResumeRecordStoreAccount: (agencyId) => request(`/record-store/admin/agencies/${agencyId}/resume-account`, { method: 'POST' }),

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
  purgeUserPreview: (userId) => request(`/users/${userId}/purge-preview`),
  purgeUser: (userId, confirmText) => request(`/users/${userId}`, { method: 'DELETE', body: { confirmText } }),
  sendPasswordReset: (userId) => request(`/users/${userId}/send-password-reset`, { method: 'POST' }),
  userPerformance: (userId, params = '') => request(`/users/${userId}/performance${params}`),
  producerNotes: (userId) => request(`/users/${userId}/notes`),
  createProducerNote: (userId, content) => request(`/users/${userId}/notes`, { method: 'POST', body: { content } }),
  coachingSummary: (userId, humorLevel) => request(`/ed/coaching-summary?userId=${userId}${humorLevel ? `&humorLevel=${humorLevel}` : ''}`),

  rosterBadges: (params = '') => request(`/roster/badges${params}`),
  awardBadge: (payload) => request('/roster/badges', { method: 'POST', body: payload }),
  revokeBadge: (id) => request(`/roster/badges/${id}`, { method: 'DELETE' }),
  rosterBirthdays: (params = '') => request(`/roster/birthdays${params}`),
  ptoRequests: (params = '') => request(`/roster/pto${params}`),
  createPtoRequest: (payload) => request('/roster/pto', { method: 'POST', body: payload }),
  reviewPtoRequest: (id, payload) => request(`/roster/pto/${id}`, { method: 'PATCH', body: payload }),
  cancelPtoRequest: (id) => request(`/roster/pto/${id}`, { method: 'DELETE' }),

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
  setOfficeAlphaAssignments: (id, assignments) => request(`/offices/${id}/alpha-assignments`, { method: 'PUT', body: { assignments } }),

  financialSummary: (params = '') => request(`/financials/summary${params}`),
  financialByVendor: (params = '') => request(`/financials/by-vendor${params}`),
  financialByAgent: (params = '') => request(`/financials/by-agent${params}`),
  billboard: (params = '') => request(`/financials/billboard${params}`),
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
  attachCallVideo: (id, bunnyVideoId) => request(`/calls/${id}/video`, { method: 'PATCH', body: { bunnyVideoId } }),
  removeCallVideo: (id) => request(`/calls/${id}/video`, { method: 'DELETE' }),
  coachingVideos: () => request('/calls/coaching-videos'),
  // Not a JSON call — used directly as an <audio crossOrigin="use-credentials" src=...>
  // so the session cookie rides along even when client/server are on separate origins.
  callAudioUrl: (id) => `${BASE}/calls/${id}/audio`,
  reviewCall: (id, payload) => request(`/calls/${id}/review`, { method: 'POST', body: payload }),
  coachingBreakdown: (params = '') => request(`/calls/coaching${params}`),
  callScoringProfile: (userId, params = '') => request(`/calls/producer-profile/${userId}${params}`),
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
  startSelfServeCheckout: (seatCount) => request('/billing/self-serve/checkout', { method: 'POST', body: seatCount ? { seatCount } : {} }),
  updateSelfServeSeats: (seatCount) => request('/billing/self-serve/seats', { method: 'POST', body: { seatCount } }),
  startSalesStudioCheckout: () => request('/billing/self-serve/sales-studio-checkout', { method: 'POST' }),
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
  // Not JSON — a multipart upload, same bypass-request() shape as bulkImportLeads.
  bulkImportCrossSell: async (file, agencyId, havesProduct, needsProduct) => {
    const formData = new FormData();
    formData.append('file', file);
    if (agencyId) formData.append('agencyId', agencyId);
    formData.append('havesProduct', havesProduct);
    formData.append('needsProduct', needsProduct);
    const res = await fetch(`${BASE}/opportunities/bulk-import-cross-sell`, { method: 'POST', credentials: 'include', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || data.error || 'Upload failed');
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  },
  searchCustomers: (q) => request(`/customers/search?q=${encodeURIComponent(q)}`),
  customerDetail: (id) => request(`/customers/${id}`),
  exportCustomer: (id) => request(`/customers/${id}/export`),
  anonymizeCustomer: (id) => request(`/customers/${id}/anonymize`, { method: 'POST' }),

  goals: (params = '') => request(`/goals${params}`),
  createGoal: (payload) => request('/goals', { method: 'POST', body: payload }),
  updateGoal: (id, payload) => request(`/goals/${id}`, { method: 'PATCH', body: payload }),
  deleteGoal: (id) => request(`/goals/${id}`, { method: 'DELETE' }),
  parseGoal: (text) => request('/goals/parse', { method: 'POST', body: { text } }),

  myRunningReport: (params = '') => request(`/running-report/me${params}`),
  agencyRunningReport: (agencyId, params = '') => request(`/running-report/agency/${agencyId}${params}`),

  chatConversations: () => request('/chat/conversations'),
  chatEntityConversation: (entityType, entityId) => request(`/chat/conversations/entity/${entityType}/${entityId}`),
  chatMessages: (conversationId) => request(`/chat/conversations/${conversationId}/messages`),
  postChatMessage: (conversationId, content) => request(`/chat/conversations/${conversationId}/messages`, { method: 'POST', body: { content } }),

  // Break Room Arcade — every route here is already gated server-side by
  // canAccessBreakRoom(); the client never decides eligibility itself, it
  // only reflects what /access says and re-polls it during gameplay.
  breakRoomAccess: () => request('/break-room/access'),
  breakRoomHome: () => request('/break-room/home'),
  startBreakRoomSession: (gameType) => request('/break-room/sessions', { method: 'POST', body: { gameType } }),
  endBreakRoomSession: (sessionId, payload) => request(`/break-room/sessions/${sessionId}/end`, { method: 'POST', body: payload }),
  breakRoomLeaderboard: (params = '') => request(`/break-room/leaderboard${params}`),
  breakRoomJoke: () => request('/break-room/jokes/random'),
  breakRoomAchievements: () => request('/break-room/achievements'),
  breakRoomStats: () => request('/break-room/stats'),
  updateAgencyBreakRoomSettings: (agencyId, payload) => request(`/agencies/${agencyId}/break-room-settings`, { method: 'PATCH', body: payload }),
  // Super Admin only.
  breakRoomAdminSessions: (params = '') => request(`/break-room/admin/sessions${params}`),
  breakRoomAdminRemoveSession: (id, reason) => request(`/break-room/admin/sessions/${id}`, { method: 'DELETE', body: { reason } }),
  breakRoomAdminResetLeaderboard: (payload) => request('/break-room/admin/reset-leaderboard', { method: 'POST', body: payload }),
  breakRoomPlatformSettings: () => request('/break-room/admin/platform-settings'),
  updateBreakRoomPlatformSettings: (payload) => request('/break-room/admin/platform-settings', { method: 'PATCH', body: payload }),

  impersonationStatus: () => request('/impersonation/status'),
  startImpersonation: (targetUserId) => request('/impersonation/start', { method: 'POST', body: { targetUserId } }),
  endImpersonation: () => request('/impersonation/end', { method: 'POST' }),
  searchUsersForImpersonation: (q) => request(`/impersonation/search-users?q=${encodeURIComponent(q)}`),

  // Backstage HR — Phase 1 Part A: Foundation. `agencyId` is appended as a
  // query param only for PLATFORM_OWNER callers (every other role is
  // locked server-side to their own agency, so it's a no-op query param
  // for them).
  hrOverview: (agencyId = '') => request(`/hr/overview${agencyId ? `?agencyId=${agencyId}` : ''}`),
  hrEmployees: (params = '') => request(`/hr/employees${params}`),
  hrEmployeeDetail: (id) => request(`/hr/employees/${id}`),
  hrMyEmployeeProfile: () => request('/hr/employees/me'),
  createHrEmployee: (payload) => request('/hr/employees', { method: 'POST', body: payload }),
  updateHrEmployee: (id, payload) => request(`/hr/employees/${id}`, { method: 'PATCH', body: payload }),
  hrDepartments: (agencyId = '') => request(`/hr/departments${agencyId ? `?agencyId=${agencyId}` : ''}`),
  createHrDepartment: (payload) => request('/hr/departments', { method: 'POST', body: payload }),
  updateHrDepartment: (id, payload) => request(`/hr/departments/${id}`, { method: 'PATCH', body: payload }),
  hrPositions: (agencyId = '') => request(`/hr/positions${agencyId ? `?agencyId=${agencyId}` : ''}`),
  createHrPosition: (payload) => request('/hr/positions', { method: 'POST', body: payload }),
  updateHrPosition: (id, payload) => request(`/hr/positions/${id}`, { method: 'PATCH', body: payload }),
  hrLegalEmployers: (agencyId = '') => request(`/hr/legal-employers${agencyId ? `?agencyId=${agencyId}` : ''}`),
  createHrLegalEmployer: (payload) => request('/hr/legal-employers', { method: 'POST', body: payload }),
  updateHrLegalEmployer: (id, payload) => request(`/hr/legal-employers/${id}`, { method: 'PATCH', body: payload }),
  hrRoleGrants: (agencyId = '') => request(`/hr/role-grants${agencyId ? `?agencyId=${agencyId}` : ''}`),
  createHrRoleGrant: (payload) => request('/hr/role-grants', { method: 'POST', body: payload }),
  revokeHrRoleGrant: (id) => request(`/hr/role-grants/${id}/revoke`, { method: 'POST' }),

  // Backstage HR — Phase 1 Part B: Time & Attendance. A read-only
  // consumer of the real time clock — never a second clock-in/out system.
  hrAttendanceLive: () => request('/hr/attendance/live'),
  hrAttendanceExceptions: (params = '') => request(`/hr/attendance/exceptions${params}`),
  reviewHrAttendanceException: (id, payload) => request(`/hr/attendance/exceptions/${id}/review`, { method: 'POST', body: payload }),
  computeHrTimesheet: (payload) => request('/hr/timesheets/compute', { method: 'POST', body: payload }),
  hrTimesheets: (params = '') => request(`/hr/timesheets${params}`),
  hrTimesheetDetail: (id) => request(`/hr/timesheets/${id}`),
  hrMyTimesheets: () => request('/hr/timesheets/mine'),
  submitHrTimesheet: (id) => request(`/hr/timesheets/${id}/submit`, { method: 'POST' }),
  approveHrTimesheet: (id) => request(`/hr/timesheets/${id}/approve`, { method: 'POST' }),
  rejectHrTimesheet: (id) => request(`/hr/timesheets/${id}/reject`, { method: 'POST' }),

  // Backstage HR — Phase 1 Part C: Scheduling & Leave.
  hrSchedule: (params = '') => request(`/hr/schedule${params}`),
  hrMySchedule: (params = '') => request(`/hr/schedule/mine${params}`),
  hrShiftTemplates: (agencyId = '') => request(`/hr/schedule/shift-templates${agencyId ? `?agencyId=${agencyId}` : ''}`),
  createHrShiftTemplate: (payload) => request('/hr/schedule/shift-templates', { method: 'POST', body: payload }),
  createHrShift: (payload) => request('/hr/schedule/shifts', { method: 'POST', body: payload }),
  updateHrShift: (id, payload) => request(`/hr/schedule/shifts/${id}`, { method: 'PATCH', body: payload }),
  cancelHrShift: (id) => request(`/hr/schedule/shifts/${id}`, { method: 'DELETE' }),
  requestHrShiftSwap: (shiftId, payload) => request(`/hr/schedule/shifts/${shiftId}/swap-request`, { method: 'POST', body: payload }),
  hrSwapRequests: (params = '') => request(`/hr/schedule/swap-requests${params}`),
  approveHrSwapRequest: (id, payload) => request(`/hr/schedule/swap-requests/${id}/approve`, { method: 'POST', body: payload }),
  denyHrSwapRequest: (id) => request(`/hr/schedule/swap-requests/${id}/deny`, { method: 'POST' }),
  hrSchedulingSettings: () => request('/hr/settings'),
  updateHrSchedulingSettings: (payload) => request('/hr/settings', { method: 'PATCH', body: payload }),

  hrLeaveTypes: () => request('/hr/leave/types'),
  createHrLeaveType: (payload) => request('/hr/leave/types', { method: 'POST', body: payload }),
  hrLeavePolicies: () => request('/hr/leave/policies'),
  createHrLeavePolicy: (payload) => request('/hr/leave/policies', { method: 'POST', body: payload }),
  hrLeavePolicyAssignments: (params = '') => request(`/hr/leave/policy-assignments${params}`),
  createHrLeavePolicyAssignment: (payload) => request('/hr/leave/policy-assignments', { method: 'POST', body: payload }),
  hrLeaveBalance: (params = '') => request(`/hr/leave/balance${params}`),
  hrLeaveRequests: (params = '') => request(`/hr/leave/requests${params}`),
  hrMyLeaveRequests: () => request('/hr/leave/requests/mine'),
  createHrLeaveRequest: (payload) => request('/hr/leave/requests', { method: 'POST', body: payload }),
  approveHrLeaveRequest: (id) => request(`/hr/leave/requests/${id}/approve`, { method: 'POST' }),
  denyHrLeaveRequest: (id, payload) => request(`/hr/leave/requests/${id}/deny`, { method: 'POST', body: payload }),
  hrLeaveCalendar: (params = '') => request(`/hr/leave/calendar${params}`),
};
