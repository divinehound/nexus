/** A centred loading spinner for a whole page. */
export function PageSpinner() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-600 border-t-purple-500" />
    </div>
  );
}
