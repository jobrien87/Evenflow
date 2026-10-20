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
  const messages = await prisma.message.findMany({ where: { conversationId: { in: conversationIds } }, select: { id: true } });
  const messageIds = messages.map((m) => m.id);
  await prisma.messageReaction.deleteMany({ where: { messageId: { in: messageIds } } });
  // Clear replyToId self-references before deleting messages — Message has
  // no onDelete: Cascade (no migration in this schema does), so a reply
  // still pointing at a to-be-deleted original would violate the FK.
  await prisma.message.updateMany({ where: { conversationId: { in: conversationIds } }, data: { replyToId: null } });
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

test('reacting to a message toggles a MessageReaction row, visible on the next read and reversible by reacting the same emoji again', async () => {
  const entityRes = await fetch(`${baseUrl}/api/chat/conversations/entity/AGENCY/${agencyId}`, { headers: { Cookie: ownerCookie } });
  const { conversation } = await entityRes.json();

  const postRes = await fetch(`${baseUrl}/api/chat/conversations/${conversation.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ content: 'React to this.' }),
  });
  const { message } = await postRes.json();

  const reactRes = await fetch(`${baseUrl}/api/chat/messages/${message.id}/reactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ emoji: '👍' }),
  });
  assert.equal(reactRes.status, 200);
  const reactBody = await reactRes.json();
  assert.equal(reactBody.reacted, true);

  const getRes1 = await fetch(`${baseUrl}/api/chat/conversations/${conversation.id}/messages`, { headers: { Cookie: ownerCookie } });
  const { messages: messages1 } = await getRes1.json();
  const found1 = messages1.find((m) => m.id === message.id);
  assert.ok(found1.reactions.some((r) => r.userId === ownerId && r.emoji === '👍'), 'the reaction must show up on the next read');

  const unreactRes = await fetch(`${baseUrl}/api/chat/messages/${message.id}/reactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ emoji: '👍' }),
  });
  assert.equal(unreactRes.status, 200);
  const unreactBody = await unreactRes.json();
  assert.equal(unreactBody.reacted, false, 'reacting with the same emoji again must toggle it off');

  const getRes2 = await fetch(`${baseUrl}/api/chat/conversations/${conversation.id}/messages`, { headers: { Cookie: ownerCookie } });
  const { messages: messages2 } = await getRes2.json();
  const found2 = messages2.find((m) => m.id === message.id);
  assert.equal(found2.reactions.length, 0, 'un-reacting must remove the row');
});

test('an unknown emoji is rejected, and the reaction route honors the same access rules as reading/posting in the conversation', async () => {
  const agencyEntityRes = await fetch(`${baseUrl}/api/chat/conversations/entity/AGENCY/${agencyId}`, { headers: { Cookie: ownerCookie } });
  const { conversation: agencyConversation } = await agencyEntityRes.json();
  const agencyPostRes = await fetch(`${baseUrl}/api/chat/conversations/${agencyConversation.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ content: 'For the bypass reaction test.' }),
  });
  const { message: agencyMessage } = await agencyPostRes.json();

  const badEmojiRes = await fetch(`${baseUrl}/api/chat/messages/${agencyMessage.id}/reactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ emoji: '🚀' }),
  });
  assert.equal(badEmojiRes.status, 400, 'only the fixed quick-react palette is accepted');

  // The platform owner's AGENCY-room bypass (platformOwnerAgencyBypass)
  // must also cover reacting, not just reading/posting.
  const bypassReactRes = await fetch(`${baseUrl}/api/chat/messages/${agencyMessage.id}/reactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ emoji: '❤️' }),
  });
  assert.equal(bypassReactRes.status, 200, 'the platform owner must be able to react in an agency team room without a participant row');

  // Same platform owner, same emoji route, but against a LEAD thread they
  // are not a participant of — the bypass must stay scoped to AGENCY only.
  const leadEntityRes = await fetch(`${baseUrl}/api/chat/conversations/entity/LEAD/${leadId}`, { headers: { Cookie: ownerCookie } });
  const { conversation: leadConversation } = await leadEntityRes.json();
  const leadPostRes = await fetch(`${baseUrl}/api/chat/conversations/${leadConversation.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ content: 'For the forbidden reaction test.' }),
  });
  const { message: leadMessage } = await leadPostRes.json();

  const forbiddenReactRes = await fetch(`${baseUrl}/api/chat/messages/${leadMessage.id}/reactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: platformOwnerCookie },
    body: JSON.stringify({ emoji: '😂' }),
  });
  assert.equal(forbiddenReactRes.status, 403, 'a platform owner with no real stake in this lead thread must not be able to react either');
});

test('replyToId only links within the same conversation — a reply in the right conversation carries its quoted message, a cross-conversation id is silently dropped', async () => {
  const agencyEntityRes = await fetch(`${baseUrl}/api/chat/conversations/entity/AGENCY/${agencyId}`, { headers: { Cookie: ownerCookie } });
  const { conversation: agencyConversation } = await agencyEntityRes.json();
  const leadEntityRes = await fetch(`${baseUrl}/api/chat/conversations/entity/LEAD/${leadId}`, { headers: { Cookie: ownerCookie } });
  const { conversation: leadConversation } = await leadEntityRes.json();

  const originalRes = await fetch(`${baseUrl}/api/chat/conversations/${agencyConversation.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ content: 'The original message.' }),
  });
  const { message: original } = await originalRes.json();

  // Same-conversation reply: replyToId must stick and the GET's include
  // must resolve the quoted message.
  const replyRes = await fetch(`${baseUrl}/api/chat/conversations/${agencyConversation.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ content: 'A real reply.', replyToId: original.id }),
  });
  assert.equal(replyRes.status, 201);
  const { message: reply } = await replyRes.json();
  assert.equal(reply.replyToId, original.id);

  const getRes = await fetch(`${baseUrl}/api/chat/conversations/${agencyConversation.id}/messages`, { headers: { Cookie: ownerCookie } });
  const { messages } = await getRes.json();
  const foundReply = messages.find((m) => m.id === reply.id);
  assert.equal(foundReply.replyTo?.id, original.id);
  assert.equal(foundReply.replyTo?.content, 'The original message.');

  // Cross-conversation reply: a replyToId pointing at a message in a
  // DIFFERENT conversation must be dropped, not trusted from the client.
  const crossReplyRes = await fetch(`${baseUrl}/api/chat/conversations/${leadConversation.id}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
    body: JSON.stringify({ content: 'Pretending to reply across conversations.', replyToId: original.id }),
  });
  assert.equal(crossReplyRes.status, 201);
  const { message: crossReply } = await crossReplyRes.json();
  assert.equal(crossReply.replyToId, null, 'a replyToId from another conversation must never be trusted');
});
