import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export async function runMigrations(connectionString: string) {
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);
  const migrationsFolder = path.resolve(__dirname, '../drizzle');
  
  console.log(`📁 Migrations folder: ${migrationsFolder}`);
  
  try {
    await migrate(db, { migrationsFolder });
    console.log('✅ Drizzle migrations applied');
  } catch (error) {
    console.error('❌ Migration error:', error);
    throw error;
  } finally {
    await sql.end();
  }
}
