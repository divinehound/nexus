import type { Metadata } from 'next';
import { Plus_Jakarta_Sans, Inter } from 'next/font/google';
import { Providers } from '@/context/providers';
import { Navbar } from '@/components/layout/navbar';
import '@/styles/globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-heading',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'NEXUS — The Dexscreener for NFT Projects & Communities',
  description:
    'Look up any NFT project instantly. Discover communities beyond your bubble. Never miss a Space again.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plusJakarta.variable} ${inter.variable}`}>
      <body className="bg-gray-950 text-white antialiased font-body">
        <Providers>
          <Navbar />
          {children}
        </Providers>
      </body>
    </html>
  );
}
