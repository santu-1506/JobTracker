export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/jobtracker_test';

/** The test suite drops the whole schema, so refuse anything that is not obviously a test database. */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.slice(1);
  if (!/test/i.test(name)) {
    throw new Error(`Refusing to run integration tests against "${name}": the database name must contain "test".`);
  }
}
