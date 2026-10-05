// Idempotent import of the Break Room "Pick Me Up" joke library — safe to
// re-run; a joke already present (matched by exact text) is skipped, so
// adding new jokes to prisma/data/breakRoomJokes.js later and re-running
// this script only ever adds the new ones.
//
// Usage: node scripts/import-break-room-jokes.js

const { prisma } = require('../src/lib/db');
const { JOKES } = require('../prisma/data/breakRoomJokes');

async function main() {
  const existing = await prisma.breakRoomJoke.findMany({ select: { text: true } });
  const existingTexts = new Set(existing.map((j) => j.text));

  const toCreate = JOKES.filter((j) => !existingTexts.has(j.text));
  if (toCreate.length > 0) {
    await prisma.breakRoomJoke.createMany({
      data: toCreate.map((j) => ({ text: j.text, tags: j.tags })),
    });
  }

  console.log(`Jokes in library: ${JOKES.length}`);
  console.log(`Created: ${toCreate.length}`);
  console.log(`Already present (skipped): ${JOKES.length - toCreate.length}`);
  const total = await prisma.breakRoomJoke.count();
  console.log(`Total rows in BreakRoomJoke now: ${total}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
