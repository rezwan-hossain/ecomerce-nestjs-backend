/**
 * The e2e database: TEST_DATABASE_URL, or DATABASE_URL with "_test"
 * appended to the database name. Refuses anything not ending in "_test",
 * so e2e tests can never write to a real database.
 */
import 'dotenv/config';

export function testDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_URL;
  let url: URL;
  if (explicit) {
    url = new URL(explicit);
  } else {
    if (!process.env.DATABASE_URL) {
      throw new Error('Set DATABASE_URL or TEST_DATABASE_URL for e2e tests');
    }
    url = new URL(process.env.DATABASE_URL);
    const name = url.pathname.slice(1);
    if (!name.endsWith('_test')) url.pathname = `/${name}_test`;
  }
  if (!url.pathname.slice(1).endsWith('_test')) {
    throw new Error(
      `Refusing to run e2e tests against "${url.pathname.slice(1)}": the database name must end in _test`,
    );
  }
  return url.toString();
}
