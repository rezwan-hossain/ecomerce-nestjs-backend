/** Creates the e2e database if needed and applies all migrations to it. */
import { execSync } from 'child_process';
import { Client } from 'pg';
import { testDatabaseUrl } from './test-db';

export default async function globalSetup() {
  const url = new URL(testDatabaseUrl());
  const name = url.pathname.slice(1);

  const admin = new URL(url);
  admin.pathname = '/postgres';
  admin.search = '';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (!rowCount) await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: 'pipe',
  });
}
