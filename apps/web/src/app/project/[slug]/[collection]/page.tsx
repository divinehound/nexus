import { redirect } from 'next/navigation';
import { apiFetch } from '@/lib/api';

interface CollectionPageProps {
  params: Promise<{ slug: string; collection: string }>;
}

interface ProjectCollection {
  id: string;
  contractAddress: string;
  chain: string;
}

interface ProjectData {
  collections: ProjectCollection[];
}

/**
 * Redirect old /project/[slug]/[collection] routes to /collection/[chain]/[contract]
 * This consolidates duplicate collection pages into a single canonical route
 */
export default async function CollectionRedirectPage({ params }: CollectionPageProps) {
  const { slug, collection: contractAddress } = await params;

  // Fetch project to get chain info
  let project: ProjectData | null = null;
  try {
    project = await apiFetch<ProjectData>(`/projects/${slug}`);
  } catch {
    // If project not found, redirect to search
    redirect(`/search?q=${contractAddress}`);
  }

  const collection = project?.collections?.find(
    (c) => c.contractAddress.toLowerCase() === contractAddress.toLowerCase(),
  ) ?? null;

  if (!collection) {
    // Collection not in project, try search
    redirect(`/search?q=${contractAddress}`);
  }

  // Redirect to canonical collection page
  redirect(`/collection/${collection.chain}/${collection.contractAddress}`);
}
