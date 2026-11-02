import { Link } from 'react-router';

export default function NotFoundPage() {
  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="mt-4 text-gray-400">There's nothing at this address.</p>
      <Link to="/" className="mt-4 inline-block text-purple-400 hover:text-purple-300">
        Back to home
      </Link>
    </main>
  );
}
