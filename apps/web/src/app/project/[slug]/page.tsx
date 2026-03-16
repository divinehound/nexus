interface ProjectPageProps {
  params: Promise<{ slug: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { slug } = await params;

  // TODO: Fetch project data from NestJS API
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-3xl font-bold">Project: {slug}</h1>

      <nav className="mt-6 flex gap-4 border-b border-gray-800">
        {['Overview', 'Wiki', 'Events', 'Activity'].map((tab) => (
          <button
            key={tab}
            className="border-b-2 border-transparent px-4 py-2 text-gray-400 transition-colors hover:border-purple-500 hover:text-white"
          >
            {tab}
          </button>
        ))}
      </nav>

      <div className="mt-8">
        <p className="text-gray-500">Project data loading...</p>
      </div>
    </main>
  );
}
