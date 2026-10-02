// Imports an externally-sourced cross-sell report (the agency's own book
// of business — people who already hold ONE product and are a real
// candidate for the complementary one) into real Customer + Opportunity
// rows, via the exact same real code path a SOLD disposition already uses
// (lib/opportunityEvents.js's updateCustomerProductsAndDetectCrossSells) —
// never a second/parallel cross-sell-creation implementation.
//
// Customer de-duplication matches routes/leads.js's createLeadRecord
// convention exactly: match by normalized phone OR email before creating
// a new Customer row, so re-running this script (or running it against a
// customer who already exists from some other path) never creates
// duplicates. Opportunity de-duplication is handled by
// updateCustomerProductsAndDetectCrossSells itself (skips a product that
// already has an OPEN/non-terminal cross-sell for that customer).
//
// Usage:
//   DATABASE_URL=... node scripts/import-cross-sell-report.js <xlsx-path> <havesProduct> <needsProduct> <agencyOwnerEmail>
//
// Example (the two real reports this was built for):
//   node scripts/import-cross-sell-report.js /path/autoNOhome.xlsx Auto Home tpaterson@allstate.com
//   node scripts/import-cross-sell-report.js /path/homeNOauto.xlsx Home Auto tpaterson@allstate.com

const XLSX = require('xlsx');
const { prisma } = require('../src/lib/db');
const { normalizePhone, normalizeEmail } = require('../src/lib/normalize');
const { updateCustomerProductsAndDetectCrossSells } = require('../src/lib/opportunityEvents');

const VALID_PRODUCTS = ['Auto', 'Home', 'Life'];

function firstPhone(row) {
  return row['Mobile Phone'] || row['Home Phone'] || row['Work Phone'] || row['Other Phone'] || null;
}

async function main() {
  const [xlsxPath, havesProduct, needsProduct, agencyOwnerEmail] = process.argv.slice(2);
  if (!xlsxPath || !havesProduct || !needsProduct || !agencyOwnerEmail) {
    console.error('Usage: node scripts/import-cross-sell-report.js <xlsx-path> <havesProduct> <needsProduct> <agencyOwnerEmail>');
    process.exit(1);
  }
  if (!VALID_PRODUCTS.includes(havesProduct) || !VALID_PRODUCTS.includes(needsProduct)) {
    console.error(`Products must be one of: ${VALID_PRODUCTS.join(', ')} (got "${havesProduct}" / "${needsProduct}")`);
    process.exit(1);
  }

  const owner = await prisma.user.findUnique({ where: { email: agencyOwnerEmail.trim().toLowerCase() } });
  if (!owner || !owner.agencyId) {
    console.error(`No agency found for owner email "${agencyOwnerEmail}".`);
    process.exit(1);
  }
  const agencyId = owner.agencyId;
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  console.log(`Target agency: ${agency.name} (${agencyId})`);
  console.log(`Report: "${xlsxPath}" — has ${havesProduct}, cross-sell ${needsProduct}\n`);

  const workbook = XLSX.readFile(xlsxPath);
  const sheetName = workbook.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null });
  console.log(`Sheet "${sheetName}": ${rows.length} rows\n`);

  let customersCreated = 0;
  let customersMatched = 0;
  let opportunitiesCreated = 0;
  let skippedNoName = 0;
  let skippedNoContact = 0;

  for (const row of rows) {
    const firstName = String(row['First Name'] ?? row['Preferred Name'] ?? row['Organization'] ?? '').trim();
    const lastName = String(row['Last Name'] ?? '').trim();
    if (!firstName && !lastName) {
      skippedNoName++;
      continue;
    }

    const phoneNormalized = normalizePhone(firstPhone(row));
    const email = normalizeEmail(row['E-mail']);
    if (!phoneNormalized && !email) {
      skippedNoContact++;
      continue;
    }

    let customer = await prisma.customer.findFirst({
      where: {
        OR: [phoneNormalized ? { phoneNormalized } : undefined, email ? { email } : undefined].filter(Boolean),
      },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          firstName: firstName || '(unknown)',
          lastName: lastName || '(unknown)',
          phoneNormalized,
          email,
          address: row['Address1'] != null ? String(row['Address1']) : null,
          city: row['City'] != null ? String(row['City']) : null,
          state: row['State'] != null ? String(row['State']) : null,
          zip: row['Zip'] != null ? String(row['Zip']) : null,
        },
      });
      customersCreated++;
    } else {
      customersMatched++;
    }

    const created = await updateCustomerProductsAndDetectCrossSells({
      customerId: customer.id,
      agencyId,
      soldProduct: havesProduct,
    });
    opportunitiesCreated += created.filter((o) => o.product === needsProduct).length;
  }

  console.log('Done.');
  console.log(`  Customers created:   ${customersCreated}`);
  console.log(`  Customers matched (already existed): ${customersMatched}`);
  console.log(`  Cross-sell opportunities created (${havesProduct} -> ${needsProduct}): ${opportunitiesCreated}`);
  console.log(`  Rows skipped (no name): ${skippedNoName}`);
  console.log(`  Rows skipped (no phone or email): ${skippedNoContact}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
