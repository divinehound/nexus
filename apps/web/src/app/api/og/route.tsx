import { ImageResponse } from 'next/og';
import { type NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const title = searchParams.get('title') ?? 'NEXUS';
  const description = searchParams.get('description') ?? 'The Dexscreener for NFT Communities';

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#0a0a0a',
          color: 'white',
        }}
      >
        <div style={{ fontSize: 64, fontWeight: 'bold' }}>{title}</div>
        <div style={{ fontSize: 24, color: '#9ca3af', marginTop: 16 }}>{description}</div>
      </div>
    ),
    { width: 1200, height: 630 },
  );
}
