'use client';

import Link from 'next/link';
import { ConnectButton } from '@/components/wallet/connect-button';
import { useAuth } from '@/context/auth-context';

export function Navbar() {
  const { user } = useAuth();

  return (
    <nav className="border-b border-gray-800 bg-gray-950/80 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-8">
          <Link href="/" className="text-xl font-bold tracking-tight text-white">
            NEXUS
          </Link>
          <div className="hidden items-center gap-6 md:flex">
            <NavLink href="/discover">Discover</NavLink>
            <NavLink href="/search">Search</NavLink>
            {user && <NavLink href="/me">My Communities</NavLink>}
          </div>
        </div>
        <ConnectButton />
      </div>
    </nav>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-sm text-gray-400 transition-colors hover:text-white">
      {children}
    </Link>
  );
}
