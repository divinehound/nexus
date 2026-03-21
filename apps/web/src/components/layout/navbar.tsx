'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ConnectButton } from '@/components/wallet/connect-button';
import { useAuth } from '@/context/auth-context';

export function Navbar() {
  const { user } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();

  const navLinks = [
    { href: '/discover', label: 'Discover' },
    { href: '/search', label: 'Search' },
    ...(user ? [{ href: '/me', label: 'Me' }] : []),
    ...(user?.role === 'admin' ? [{ href: '/admin', label: 'Admin' }] : []),
  ];

  return (
    <nav className="border-b border-gray-800 bg-gray-950/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex items-center justify-between py-3">
          {/* Logo */}
          <Link href="/" className="text-xl font-bold tracking-tight text-white">
            NEXUS
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden items-center gap-6 md:flex">
            {navLinks.map((link) => (
              <NavLink key={link.href} href={link.href} active={pathname === link.href}>
                {link.label}
              </NavLink>
            ))}
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-3">
            <div className="hidden md:block">
              <ConnectButton />
            </div>

            {/* Mobile Menu Button */}
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white md:hidden"
              aria-label="Toggle menu"
            >
              {mobileMenuOpen ? (
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Mobile Menu */}
        {mobileMenuOpen && (
          <div className="border-t border-gray-800 py-3 md:hidden">
            <div className="flex flex-col gap-3">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    pathname === link.href
                      ? 'bg-purple-500/10 text-purple-400'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                  }`}
                >
                  {link.label}
                </Link>
              ))}
              <div className="pt-2">
                <ConnectButton />
              </div>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}

function NavLink({ href, children, active }: { href: string; children: React.ReactNode; active?: boolean }) {
  return (
    <Link
      href={href}
      className={`text-sm font-medium transition-colors ${
        active ? 'text-purple-400' : 'text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </Link>
  );
}
