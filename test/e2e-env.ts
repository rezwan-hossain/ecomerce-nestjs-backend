// Points every PrismaClient in the e2e run at the test database.
import { testDatabaseUrl } from './test-db';

process.env.DATABASE_URL = testDatabaseUrl();
