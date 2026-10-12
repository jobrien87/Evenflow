// Notification-channel unit tests. Database and email adapters are isolated
// so these tests cannot send real mail or touch a live database. Existing
// agencyChat/staleLeadReminders integration tests cover the database queries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule(name, dependencies) {
  const filename = path.join(__dirname, `${name}.js`);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    require: (id) => {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    console: { error: () => {} },
    process: { env: {} },
    Date,
  }, { filename });
  return module.exports;
}

function harness({ preference = null, configured = true, emailError = null } = {}) {
  const notifications = [];
  const emails = [];
  const emailLookups = [];
  const prisma = {
    notificationPreference: { findUnique: async () => preference },
    notification: {
      create: async ({ data }) => {
        const row = { id: `notification-${notifications.length + 1}`, ...data };
        notifications.push(row);
        return row;
      },
    },
    user: {
      findUnique: async ({ where }) => {
        emailLookups.push(where.id);
        return { email: `${where.id}@example.test` };
      },
      findMany: async () => [{ id: 'owner' }, { id: 'manager' }],
    },
  };
  const email = {
    isConfigured: () => configured,
    sendEmail: async (message) => {
      emails.push(message);
      if (emailError) throw emailError;
    },
  };
  const api = loadModule('notifications', { './db': { prisma }, './email': email });
  return { ...api, prisma, notifications, emails, emailLookups };
}

const payload = {
  userId: 'producer',
  agencyId: 'agency',
  title: 'Notification title',
  body: 'Notification body',
  relatedEntityId: 'entity',
};

for (const [label, type, relatedEntityType, severity] of [
  ['team chat', 'chat.message', 'AGENCY', 'INFO'],
  ['stale-lead reminder', 'lead.stale', 'Lead', 'WARNING'],
  ['speed-to-lead alert', 'lead.first_attempt_overdue', 'Lead', 'CRITICAL'],
]) {
  for (const [preferenceLabel, preference] of [
    ['default email settings', null],
    ['email enabled', { emailEnabled: true, mutedTypes: [] }],
    ['email disabled', { emailEnabled: false, mutedTypes: [] }],
  ]) {
    test(`${label} stays in-app with ${preferenceLabel}`, async () => {
      const h = harness({ preference });
      const notification = await h.notifyUser({ ...payload, type, relatedEntityType, severity });
      assert.equal(h.notifications.length, 1);
      assert.equal(notification, h.notifications[0]);
      for (const [key, value] of Object.entries({ ...payload, type, relatedEntityType, severity })) {
        assert.equal(notification[key], value);
      }
      assert.equal(h.emails.length, 0);
      assert.equal(h.emailLookups.length, 0);
    });
  }
}

for (const [type, relatedEntityType, severity] of [
  ['chat.message', 'Lead', 'INFO'],
  ['chat.message', 'Transfer', 'INFO'],
  ['lead.assigned', 'Lead', 'INFO'],
  ['transfer.offered', 'Transfer', 'CRITICAL'],
]) {
  test(`${type} for ${relatedEntityType} still emails`, async () => {
    const h = harness();
    await h.notifyUser({ ...payload, type, relatedEntityType, severity });
    assert.equal(h.notifications.length, 1);
    assert.equal(h.emails.length, 1);
    assert.equal(h.emails[0].to, 'producer@example.test');
    assert.equal(h.emails[0].subject, payload.title);
    assert.equal(h.emails[0].html, `<p>${payload.body}</p>`);
  });
}

test('other emails still respect the recipient email preference and provider configuration', async () => {
  for (const options of [
    { preference: { emailEnabled: false, mutedTypes: [] } },
    { configured: false },
  ]) {
    const h = harness(options);
    await h.notifyUser({ ...payload, type: 'lead.assigned' });
    assert.equal(h.notifications.length, 1);
    assert.equal(h.emails.length, 0);
  }
});

test('non-critical type mutes still suppress both notification channels', async () => {
  const h = harness({ preference: { emailEnabled: true, mutedTypes: ['chat.message'] } });
  const result = await h.notifyUser({ ...payload, type: 'chat.message', relatedEntityType: 'AGENCY' });
  assert.equal(result, null);
  assert.equal(h.notifications.length, 0);
  assert.equal(h.emails.length, 0);
});

test('critical transfer alerts still override type mutes', async () => {
  const h = harness({ preference: { emailEnabled: true, mutedTypes: ['transfer.offered'] } });
  await h.notifyUser({ ...payload, type: 'transfer.offered', severity: 'CRITICAL' });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.emails.length, 1);
});

test('in-app-only events cannot email even at critical severity', async () => {
  for (const type of ['chat.message', 'lead.stale', 'lead.first_attempt_overdue']) {
    const h = harness({ preference: { emailEnabled: true, mutedTypes: [type] } });
    await h.notifyUser({ ...payload, type, relatedEntityType: 'AGENCY', severity: 'CRITICAL' });
    assert.equal(h.notifications.length, 1);
    assert.equal(h.emails.length, 0);
  }
});

test('bulk and agency-owner notifications use the same channel policy', async () => {
  const h = harness();
  await h.notifyUsers(['one', 'two'], { ...payload, type: 'chat.message', relatedEntityType: 'AGENCY' });
  await h.notifyAgencyOwners('agency', { ...payload, type: 'lead.stale' });
  assert.equal(h.notifications.length, 4);
  assert.deepEqual(h.notifications.map((row) => row.userId), ['one', 'two', 'owner', 'manager']);
  assert.equal(h.emails.length, 0);
});

test('email failures still preserve the in-app notification', async () => {
  const h = harness({ emailError: new Error('provider unavailable') });
  const notification = await h.notifyUser({ ...payload, type: 'lead.assigned' });
  assert.equal(notification, h.notifications[0]);
  assert.equal(h.emails.length, 1);
});

test('posting a team-room message keeps participant notifications and skips email', async () => {
  const h = harness();
  const message = { id: 'message' };
  h.prisma.message = { create: async () => message };
  h.prisma.conversation = {
    findUnique: async () => ({ agencyId: 'agency', relatedEntityType: 'AGENCY', relatedEntityId: 'agency' }),
  };
  h.prisma.conversationParticipant = {
    update: async () => ({}),
    findMany: async () => [{ userId: 'one' }, { userId: 'two' }],
  };
  h.prisma.user.findUnique = async () => ({ firstName: 'Test', lastName: 'Author' });
  const chat = loadModule('chat', { './db': { prisma: h.prisma }, './notifications': h });
  assert.equal(await chat.postMessage({ conversationId: 'room', authorId: 'author', content: 'Hello team' }), message);
  // Chat notification delivery is deliberately asynchronous in production.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[0].title, 'New message from Test Author');
  assert.equal(h.notifications[0].body, 'Hello team');
  assert.equal(h.emails.length, 0);
});

test('stale-lead sweep keeps its in-app reminder and repeat-reminder timestamp', async () => {
  const h = harness();
  const updates = [];
  h.prisma.lead = {
    findMany: async () => [{
      id: 'stale', agencyId: 'agency', assignedToId: 'producer',
      customer: { firstName: 'Test', lastName: 'Lead' }, notes: [], activities: [], events: [],
    }],
    update: async (args) => { updates.push(args); },
  };
  const stale = loadModule('staleLeadReminders', { './db': { prisma: h.prisma }, './notifications': h });
  const result = await stale.checkStaleLeads();
  assert.equal(result.checked, 1);
  assert.equal(result.reminded, 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].title, 'Lead needs a note or update');
  assert.equal(h.emails.length, 0);
  assert.equal(updates[0].where.id, 'stale');
  assert.ok(updates[0].data.lastReminderSentAt instanceof Date);
});

test('speed-to-lead sweep keeps its critical in-app alert and one-time alert timestamp', async () => {
  const h = harness({ preference: { emailEnabled: true, mutedTypes: ['lead.first_attempt_overdue'] } });
  const updates = [];
  h.prisma.lead = {
    findMany: async () => [{
      id: 'overdue', agencyId: 'agency', assignedToId: 'producer',
      customer: { firstName: 'Test', lastName: 'Lead' },
    }],
    update: async (args) => { updates.push(args); },
  };
  const sla = loadModule('firstAttemptSlaAlerts', { './db': { prisma: h.prisma }, './notifications': h });
  assert.equal(await sla.checkFirstAttemptSla(), 1);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].type, 'lead.first_attempt_overdue');
  assert.equal(h.notifications[0].severity, 'CRITICAL');
  assert.equal(h.emails.length, 0);
  assert.equal(updates[0].where.id, 'overdue');
  assert.ok(updates[0].data.firstAttemptSlaAlertSentAt instanceof Date);
});
