import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function runMigrations(pool, directory) {
  const files = (await readdir(directory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(726153204)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(path.join(directory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      console.log(`Applied database migration ${file}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
