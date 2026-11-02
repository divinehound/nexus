import { isRouteErrorResponse, Link, useRouteError } from 'react-router';

/** Shown when a page throws, or its code can't be loaded (e.g. an old tab after a deploy). */
export default function RouteError() {
  const error = useRouteError();
  console.error(error);
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'Unknown error';

  return (
    <main className="mx-auto max-w-7xl px-4 py-8">
      <h1 className="text-3xl font-bold">Something went wrong</h1>
      <p className="mt-4 text-gray-400">{message}</p>
      <div className="mt-4 flex items-center gap-4">
        <button
          onClick={() => window.location.reload()}
          className="text-purple-400 hover:text-purple-300"
        >
          Reload the page
        </button>
        <Link to="/" className="text-purple-400 hover:text-purple-300">
          Back to home
        </Link>
      </div>
    </main>
  );
}
