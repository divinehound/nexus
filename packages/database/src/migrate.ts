import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

export async function runMigrations(connectionString: string) {
  const sql = postgres(connectionString, { max: 1 });
  const db = drizzle(sql);
  
  // In production, migrations are copied to /app/drizzle-migrations
  // In development, they're in ../drizzle
  const migrationsFolder = process.env.NODE_ENV === 'production' 
    ? path.resolve(process.cwd(), 'drizzle-migrations')
    : path.resolve(__dirname, '../drizzle');
  
  console.log(`📁 Migrations folder: ${migrationsFolder}`);
  console.log(`📁 Files in folder: ${require('fs').readdirSync(migrationsFolder).join(', ')}`);
  
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
