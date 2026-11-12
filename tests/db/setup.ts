// Runs before any test module loads, so Prisma binds to the TEST database only.
export {}; // make this a module so its top-level names cannot collide with global declarations
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error("TEST_DATABASE_URL is not set (run via `npm run test:db`)");
if (!/\/mandate_test(\?|$)/.test(url)) throw new Error("Refusing to run DB tests: TEST_DATABASE_URL must point at the mandate_test database");
process.env.DATABASE_URL = url;
