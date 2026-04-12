'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AuthGate } from '@/components/wallet/auth-gate';
import { useAuth } from '@/context/auth-context';

const navItems = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/collections', label: 'Collections' },
  { href: '/admin/projects', label: 'Projects' },
  { href: '/admin/wiki', label: 'Wiki Suggestions' },
  { href: '/admin/events', label: 'Events' },
  { href: '/admin/indexing', label: 'Indexing Queue' },
  { href: '/admin/users', label: 'Users' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <AdminGate>{children}</AdminGate>
    </AuthGate>
  );
}

function AdminGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();

  if (user?.role !== 'admin') {
    return (
      <main className="mx-auto max-w-7xl px-4 py-8">
        <h1 className="text-3xl font-bold">Access Denied</h1>
        <p className="mt-4 text-gray-400">You do not have admin privileges.</p>
        <Link href="/" className="mt-4 inline-block text-purple-400 hover:text-purple-300">
          Back to home
        </Link>
      </main>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-purple-400">Admin Panel</h1>
        <Link href="/" className="text-sm text-gray-500 hover:text-white">
          Back to site
        </Link>
      </div>
      <nav className="mb-8 flex gap-1 border-b border-gray-800">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`border-b-2 px-4 py-2 text-sm transition-colors ${
              pathname === item.href
                ? 'border-purple-500 text-white'
                : 'border-transparent text-gray-400 hover:text-white'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
