import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { apiFetch } from '@/lib/api';
import { PageSpinner } from '@/components/ui/page-spinner';

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
export default function CollectionRedirectPage() {
  const { slug = '', collection: contractAddress = '' } = useParams<{
    slug: string;
    collection: string;
  }>();
  const navigate = useNavigate();

  useEffect(() => {
    let stale = false;
    apiFetch<ProjectData>(`/projects/${slug}`)
      .catch(() => null)
      .then((project) => {
        if (stale) return;
        const collection = project?.collections?.find(
          (c) => c.contractAddress.toLowerCase() === contractAddress.toLowerCase(),
        );
        navigate(
          collection
            ? `/collection/${collection.chain}/${collection.contractAddress}`
            : // Project or collection not found: try search
              `/search?q=${encodeURIComponent(contractAddress)}`,
          { replace: true },
        );
      });
    return () => {
      stale = true;
    };
  }, [slug, contractAddress, navigate]);

  return <PageSpinner />;
}
