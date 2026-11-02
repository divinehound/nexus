import { Link } from 'react-router';
import { useEffect, useState } from 'react';
import { useAuth } from '@/context/auth-context';
import { apiFetch } from '@/lib/api';

/** A link to the holder analysis, shown only to the project's owners, editors and admins, once it's turned on. */
export function HolderAnalysisLink({ projectId, slug }: { projectId: string; slug: string }) {
  const { accessToken } = useAuth();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!accessToken) return setShow(false);
    let stale = false;
    apiFetch<{ enabled: boolean }>(`/projects/${projectId}/holder-analysis/access`, { token: accessToken })
      .then((r) => !stale && setShow(r.enabled))
      .catch(() => !stale && setShow(false));
    return () => {
      stale = true;
    };
  }, [accessToken, projectId]);
  if (!show) return null;
  return (
    <Link to={`/project/${slug}/holders`} className="inline-flex items-center rounded border border-purple-700 px-3 py-1.5 text-sm text-purple-200 hover:border-purple-500 hover:text-white">
      Holder analysis
    </Link>
  );
}
