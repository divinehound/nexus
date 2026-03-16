import type { Metadata } from 'next';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'NEXUS — The Dexscreener for NFT Projects & Communities',
  description:
    'Look up any NFT project instantly. Discover communities beyond your bubble. Never miss a Space again.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-white antialiased">{children}</body>
    </html>
  );
}
