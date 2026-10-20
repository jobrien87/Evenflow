// Real-DB, real-HTTP tests for the Platform Owner Chats tab: a Platform
// Owner can read/post in any agency's AGENCY-type team room without being
// a real ConversationParticipant row, via routes/chat.js's
// platformOwnerAgencyBypass — deliberately scoped to AGENCY conversations
// only, never LEAD/TRANSFER.
process.env.NODE_ENV = 'development';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const bcrypt = require('bcryptjs');
const { prisma } = require('../lib/db');
const { createSession } = require('../lib/auth');
const app = require('../app');

const suffix = Date.now();
let agencyId, ownerId, ownerCookie, platformOwnerId, platformOwnerCookie, leadId, customerId, server, baseUrl;

before(async () => {
  const agency = await prisma.agency.create({ data: { name: `Chat Test Agency ${suffix}` } });
  agencyId = agency.id;
  const hash = await bcrypt.hash('TestPass123!', 12);

  const owner = await prisma.user.create({
    data: { email: `chat-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Chat', lastName: 'Owner', role: 'AGENCY_OWNER', agencyId, status: 'ACTIVE' },
  });
  ownerId = owner.id;
  const ownerSession = await createSession(ownerId);
  ownerCookie = `evenflow_session=${ownerSession.rawToken}`;

  const platformOwner = await prisma.user.create({
    data: { email: `chat-platform-owner-${suffix}@test.local`, passwordHash: hash, firstName: 'Platform', lastName: 'Owner', role: 'PLATFORM_OWNER', status: 'ACTIVE' },
  });
  platformOwnerId = platformOwner.id;
  const platformSession = await createSession(platformOwnerId);
  platformOwnerCookie = `evenflow_session=${platformSession.rawToken}`;

  const customer = await prisma.customer.create({ data: { firstName: 'Lead', lastName: 'Customer' } });
  customerId = customer.id;
  const lead = await prisma.lead.create({
    data: { agencyId, customerId, assignedToId: ownerId, createdById: ownerId, status: 'NEW' },
  });
  leadId = lead.id;

  await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  const conversations = await prisma.conversation.findMany({ where: { agencyId } });
  const conversationIds = conversations.map((c) => c.id);
  await prisma.message.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.conversationParticipant.deleteMany({ where: { conversationId: { in: conversationIds } } });
  await prisma.conversation.deleteMany({ where: { agencyId } });
  await prisma.lead.deleteMany({ where: { id: leadId } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.session.deleteMany({ where: { userId: { in: [ownerId, platformOwnerId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, platformOwnerId] } } });
  await prisma.agency.delete({ where: { id: agencyId } });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

test('a Platform Owner can open, read, and post in an agency\'s AGENCY team room without ever being a participant row', async () => {
  const entityRes = await fetch(`${baseUrl}/api/chat/conversations/entity/AGENCY/${agencyId}`, { headers: { Cookie: platformOwnerCookie } });
  assert.equal(entityRes.status, 200);
  const { conversation } = await entityRes.json();
  assert.equal(conversation.relatedEntityType, 'AGENCY');

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: conversation.id, userId: platformOwnerId } },
  });
  assert.equal(participant, null, 'the platform owner must never need a real participant row to get access');

  const getRes = await fetch(`${baseUrl}/api/chat/conversations/${conversation.id}/messages`, { headers: { Cookie: platformOwnerCookie } });
  assert.equal(getRes.status, 200, 'reading messages must succeed despite no participant row');

  const postRes = await fetch(`${baseUrl}/api/chat/conversations/${conversation.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ content: 'Checking in from the platform team.' }),
  });
  assert.equal(postRes.status, 201, 'posting must succeed despite no participant row');
  const { message } = await postRes.json();
  assert.equal(message.authorId, platformOwnerId);

  // The real agency owner (a genuine participant) must see the platform
  // owner's message when they read the same room.
  const ownerGetRes = await fetch(`${baseUrl}/api/chat/conversations/${conversation.id}/messages`, { headers: { Cookie: ownerCookie } });
  assert.equal(ownerGetRes.status, 200);
  const { messages } = await ownerGetRes.json();
  assert.ok(messages.some((m) => m.id === message.id), 'the agency owner must see the platform owner\'s message in their own team room');
});

test('the platform-owner bypass is scoped to AGENCY conversations only — a LEAD thread the platform owner is not a participant of still 403s', async () => {
  const entityRes = await fetch(`${baseUrl}/api/chat/conversations/entity/LEAD/${leadId}`, { headers: { Cookie: ownerCookie } });
  assert.equal(entityRes.status, 200);
  const { conversation } = await entityRes.json();
  assert.equal(conversation.relatedEntityType, 'LEAD');

  const getRes = await fetch(`${baseUrl}/api/chat/conversations/${conversation.id}/messages`, { headers: { Cookie: platformOwnerCookie } });
  assert.equal(getRes.status, 403, 'a platform owner with no real stake in this specific lead thread must not get a free pass the way AGENCY rooms do');

  const postRes = await fetch(`${baseUrl}/api/chat/conversations/${conversation.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ content: 'Should not be allowed.' }),
  });
  assert.equal(postRes.status, 403);
});
