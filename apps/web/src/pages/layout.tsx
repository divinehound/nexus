import { Outlet, ScrollRestoration } from 'react-router';
import { Providers } from '@/context/providers';
import { Navbar } from '@/components/layout/navbar';
import { Toaster } from '@/components/ui/toast';

export default function RootLayout() {
  return (
    <Providers>
      <Navbar />
      <Outlet />
      <Toaster />
      {/* New pages open at the top; back and forward restore the old position. */}
      <ScrollRestoration />
    </Providers>
  );
}
