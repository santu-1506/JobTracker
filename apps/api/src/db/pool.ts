import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a query: the pool itself or a checked-out client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, max = 10): Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'jobtracker-api',
  });
}

export async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
