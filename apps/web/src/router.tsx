import { createBrowserRouter, type RouteObject } from 'react-router';
import RootLayout from '@/pages/layout';
import NotFoundPage from '@/pages/not-found';
import RouteError from '@/pages/route-error';
import { PageSpinner } from '@/components/ui/page-spinner';

type PageModule = { default: React.ComponentType };

/** Loads a page's code only when its route is first visited. */
const page = (load: () => Promise<PageModule>): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => ({ Component: (await load()).default }),
});

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    hydrateFallbackElement: <PageSpinner />,
    children: [
      {
        // Errors render inside the layout, so the navbar and providers stay.
        errorElement: <RouteError />,
        children: [
          { index: true, ...page(() => import('@/pages/page')) },
          { path: 'search', ...page(() => import('@/pages/search/page')) },
          { path: 'discover', ...page(() => import('@/pages/discover/page')) },
          { path: 'link-wallet', ...page(() => import('@/pages/link-wallet/page')) },
          {
            path: 'collection/:chain/:contract',
            ...page(() => import('@/pages/collection/[chain]/[contract]/page')),
          },
          {
            path: 'me',
            children: [
              { index: true, ...page(() => import('@/pages/me/page')) },
              { path: 'card', ...page(() => import('@/pages/me/card/page')) },
              { path: 'money', ...page(() => import('@/pages/me/money/page')) },
            ],
          },
          {
            path: 'project/:slug',
            children: [
              { index: true, ...page(() => import('@/pages/project/[slug]/page')) },
              {
                path: 'holders',
                ...page(() => import('@/pages/project/[slug]/holders/layout')),
                children: [
                  { index: true, ...page(() => import('@/pages/project/[slug]/holders/page')) },
                  {
                    path: 'groups',
                    ...page(() => import('@/pages/project/[slug]/holders/groups/page')),
                  },
                  {
                    path: 'activity',
                    ...page(() => import('@/pages/project/[slug]/holders/activity/page')),
                  },
                  {
                    path: 'wallet/:address',
                    ...page(() => import('@/pages/project/[slug]/holders/wallet/[address]/page')),
                  },
                ],
              },
              // Old collection links: redirects to /collection/:chain/:contract
              {
                path: ':collection',
                ...page(() => import('@/pages/project/[slug]/[collection]/page')),
              },
            ],
          },
          {
            path: 'admin',
            ...page(() => import('@/pages/admin/layout')),
            children: [
              { index: true, ...page(() => import('@/pages/admin/page')) },
              { path: 'collections', ...page(() => import('@/pages/admin/collections/page')) },
              {
                path: 'collections/:id/holder-history',
                ...page(() => import('@/pages/admin/collections/[id]/holder-history/page')),
              },
              { path: 'projects', ...page(() => import('@/pages/admin/projects/page')) },
              { path: 'projects/:id', ...page(() => import('@/pages/admin/projects/[id]/page')) },
              { path: 'wiki', ...page(() => import('@/pages/admin/wiki/page')) },
              { path: 'events', ...page(() => import('@/pages/admin/events/page')) },
              { path: 'indexing', ...page(() => import('@/pages/admin/indexing/page')) },
              { path: 'users', ...page(() => import('@/pages/admin/users/page')) },
            ],
          },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
