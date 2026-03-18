import { createDatabase } from './client';
import {
  users,
  wallets,
  projects,
  collections,
  events,
  activityFeed,
  projectWiki,
  projectOwners,
} from './schema';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:password@localhost:5432/nexus';

async function seed() {
  console.log('Seeding database…');
  const db = createDatabase(DATABASE_URL);

  // 1. Admin user
  const [adminUser] = await db
    .insert(users)
    .values({ role: 'admin' })
    .returning();
  console.log(`  Created admin user: ${adminUser.id}`);

  const [adminWallet] = await db
    .insert(wallets)
    .values({
      address: '0x000000000000000000000000000000000000dEaD',
      chain: 'ethereum',
      userId: adminUser.id,
    })
    .returning();

  await db
    .update(users)
    .set({ primaryWalletId: adminWallet.id })
    .where(
      // drizzle eq import
      (await import('drizzle-orm')).eq(users.id, adminUser.id),
    );

  // 2. Sample project
  const [project] = await db
    .insert(projects)
    .values({
      name: 'Example DAO',
      slug: 'example-dao',
      description: 'A sample project for development and testing.',
      twitterUrl: 'https://twitter.com/example',
      discordUrl: 'https://discord.gg/example',
      isVerified: true,
      healthScore: 72,
    })
    .returning();
  console.log(`  Created project: ${project.name} (${project.id})`);

  // 3. Collections
  const [collection] = await db
    .insert(collections)
    .values({
      projectId: project.id,
      contractAddress: '0x1234567890abcdef1234567890abcdef12345678',
      chain: 'ethereum',
      name: 'Example Genesis',
      supply: 5000,
      floorPrice: 0.42,
      holderCount: 2100,
      listedCount: 320,
      collectionType: 'erc721',
    })
    .returning();
  console.log(`  Created collection: ${collection.name}`);

  // 4. Project owner
  await db.insert(projectOwners).values({
    projectId: project.id,
    userId: adminUser.id,
    role: 'owner',
  });

  // 5. Wiki
  await db.insert(projectWiki).values({
    projectId: project.id,
    descriptionMd:
      '# Example DAO\n\nA sample project for local development.\n\n## Timeline\n- **2024-01** — Collection launched',
  });

  // 6. Sample event
  await db.insert(events).values({
    projectId: project.id,
    title: 'Community AMA',
    description: 'Weekly community AMA with the founders.',
    eventType: 'ama',
    startTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    source: 'manual',
    status: 'upcoming',
    submittedBy: adminUser.id,
  });

  // 7. Sample activity
  await db.insert(activityFeed).values({
    projectId: project.id,
    activityType: 'sale',
    walletAddress: '0xaabbccddee00112233445566778899aabbccddee',
    collectionId: collection.id,
    tokenId: '42',
    price: 1.5,
  });

  console.log('Seed complete!');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
