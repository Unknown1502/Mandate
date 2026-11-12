// Imported FIRST by the CLI: points Prisma at the TEST database only, before any module creates a client.
export {};
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !/\/mandate_test(\?|$)/.test(testUrl)) {
  console.error("Attack Lab refuses to run: TEST_DATABASE_URL must point at the mandate_test database (see .env.local).");
  process.exit(2);
}
process.env.DATABASE_URL = testUrl;
