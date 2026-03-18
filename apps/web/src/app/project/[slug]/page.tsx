import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { formatPrice, truncateAddress } from '@/lib/utils';

interface ProjectPageProps {
  params: Promise<{ slug: string }>;
}

interface ProjectData {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  bannerUrl: string | null;
  websiteUrl: string | null;
  twitterUrl: string | null;
  discordUrl: string | null;
  healthScore: number | null;
  isVerified: boolean;
  collections: CollectionData[];
  wiki: { descriptionMd: string | null } | null;
  events: EventData[];
}

interface CollectionData {
  id: string;
  name: string;
  contractAddress: string;
  chain: string;
  supply: number | null;
  floorPrice: number | null;
  holderCount: number | null;
  listedCount: number | null;
  imageUrl: string | null;
}

interface EventData {
  id: string;
  title: string;
  eventType: string;
  startTime: string;
  status: string;
  link: string | null;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { slug } = await params;

  let project: ProjectData | null = null;
  let error: string | null = null;

  try {
    project = await apiFetch<ProjectData>(`/projects/${slug}`);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to load project';
  }

  if (error || !project) {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="text-3xl font-bold">Project not found</h1>
        <p className="mt-4 text-gray-400">{error || `No project found with slug "${slug}"`}</p>
        <Link href="/" className="mt-4 inline-block text-purple-400 hover:text-purple-300">
          Back to home
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      {/* Header */}
      <div className="flex items-start gap-6">
        {project.imageUrl && (
          <img
            src={project.imageUrl}
            alt={project.name}
            className="h-20 w-20 rounded-xl object-cover"
          />
        )}
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">{project.name}</h1>
            {project.isVerified && (
              <span className="rounded bg-purple-600/20 px-2 py-0.5 text-xs text-purple-400">Verified</span>
            )}
            {project.healthScore !== null && (
              <span className={`rounded px-2 py-0.5 text-xs ${
                project.healthScore >= 70 ? 'bg-green-600/20 text-green-400' :
                project.healthScore >= 40 ? 'bg-yellow-600/20 text-yellow-400' :
                'bg-red-600/20 text-red-400'
              }`}>
                Score: {project.healthScore}
              </span>
            )}
          </div>
          {project.description && (
            <p className="mt-2 text-gray-400">{project.description}</p>
          )}
          <div className="mt-2 flex gap-4">
            {project.websiteUrl && (
              <a href={project.websiteUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-gray-500 hover:text-white">Website</a>
            )}
            {project.twitterUrl && (
              <a href={project.twitterUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-gray-500 hover:text-white">Twitter</a>
            )}
            {project.discordUrl && (
              <a href={project.discordUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-gray-500 hover:text-white">Discord</a>
            )}
          </div>
        </div>
      </div>

      {/* Collections */}
      <section className="mt-10">
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Collections</h2>
        {project.collections.length === 0 ? (
          <p className="text-sm text-gray-500">No collections found.</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {project.collections.map((c) => (
              <Link
                key={c.id}
                href={`/project/${slug}/${c.contractAddress}`}
                className="rounded-xl border border-gray-800 p-4 transition-colors hover:border-gray-600"
              >
                <div className="flex items-center gap-3">
                  {c.imageUrl && (
                    <img src={c.imageUrl} alt={c.name} className="h-10 w-10 rounded-lg object-cover" />
                  )}
                  <div>
                    <h3 className="font-medium">{c.name}</h3>
                    <p className="text-xs text-gray-500">{c.chain} · {truncateAddress(c.contractAddress)}</p>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  {c.floorPrice !== null && (
                    <div>
                      <span className="text-gray-500">Floor: </span>
                      <span>{formatPrice(c.floorPrice, c.chain === 'solana' ? 'SOL' : 'ETH')}</span>
                    </div>
                  )}
                  {c.holderCount !== null && (
                    <div>
                      <span className="text-gray-500">Holders: </span>
                      <span>{c.holderCount.toLocaleString()}</span>
                    </div>
                  )}
                  {c.supply !== null && (
                    <div>
                      <span className="text-gray-500">Supply: </span>
                      <span>{c.supply.toLocaleString()}</span>
                    </div>
                  )}
                  {c.listedCount !== null && (
                    <div>
                      <span className="text-gray-500">Listed: </span>
                      <span>{c.listedCount.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Wiki */}
      {project.wiki?.descriptionMd && (
        <section className="mt-10">
          <h2 className="mb-4 text-lg font-semibold text-gray-300">Wiki</h2>
          <div className="rounded-xl border border-gray-800 p-6 text-gray-300">
            {project.wiki.descriptionMd}
          </div>
        </section>
      )}

      {/* Events */}
      <section className="mt-10">
        <h2 className="mb-4 text-lg font-semibold text-gray-300">Events</h2>
        {project.events.length === 0 ? (
          <p className="text-sm text-gray-500">No upcoming events.</p>
        ) : (
          <div className="space-y-3">
            {project.events.map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded-xl border border-gray-800 px-4 py-3">
                <div>
                  <span className={`mr-2 text-xs font-medium uppercase ${
                    e.status === 'live' ? 'text-red-400' :
                    e.status === 'upcoming' ? 'text-green-400' : 'text-gray-500'
                  }`}>
                    {e.status}
                  </span>
                  <span className="font-medium">{e.title}</span>
                  <span className="ml-2 text-xs text-gray-500">{e.eventType}</span>
                </div>
                <div className="text-sm text-gray-500">
                  {new Date(e.startTime).toLocaleDateString()}
                  {e.link && (
                    <a href={e.link} target="_blank" rel="noopener noreferrer" className="ml-3 text-purple-400 hover:text-purple-300">
                      Link
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
