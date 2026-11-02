import { Outlet, ScrollRestoration } from 'react-router';
import { Providers } from '@/context/providers';
import { Navbar } from '@/components/layout/navbar';
import { Toaster } from '@/components/ui/toast';
import { DialogHost } from '@/components/ui/dialogs';

export default function RootLayout() {
  return (
    <Providers>
      <Navbar />
      <Outlet />
      <Toaster />
      <DialogHost />
      {/* New pages open at the top; back and forward restore the old position. */}
      <ScrollRestoration />
    </Providers>
  );
}
