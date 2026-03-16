interface CollectionPageProps {
  params: Promise<{ slug: string; collection: string }>;
}

export default async function CollectionPage({ params }: CollectionPageProps) {
  const { slug, collection } = await params;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <nav className="text-sm text-gray-500">
        <a href={`/project/${slug}`} className="hover:text-white">
          {slug}
        </a>
        <span className="mx-2">/</span>
        <span className="text-white">{collection}</span>
      </nav>
      <h1 className="mt-4 text-3xl font-bold">Collection: {collection}</h1>
      <p className="mt-4 text-gray-500">Collection detail loading...</p>
    </main>
  );
}
