import { ImageResponse } from 'next/og';
import { type NextRequest } from 'next/server';

export const runtime = 'edge';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Generic or project-specific card
  const title = searchParams.get('title') ?? 'NEXUS';
  const description =
    searchParams.get('description') ?? 'The Dexscreener for NFT Communities';
  const imageUrl = searchParams.get('image') ?? null;
  const floorPrice = searchParams.get('floor') ?? null;
  const holders = searchParams.get('holders') ?? null;
  const healthScore = searchParams.get('health') ?? null;
  const listed = searchParams.get('listed') ?? null;

  const isProjectCard = floorPrice || holders || healthScore;

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#0a0a0a',
          color: 'white',
          padding: 60,
          fontFamily: 'sans-serif',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: 'auto',
          }}
        >
          <div
            style={{
              fontSize: 20,
              fontWeight: 'bold',
              color: '#6366f1',
              letterSpacing: 2,
            }}
          >
            NEXUS
          </div>
        </div>

        {/* Body */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 40,
            flex: 1,
          }}
        >
          {/* Project image */}
          {imageUrl && (
            <div
              style={{
                display: 'flex',
                width: 180,
                height: 180,
                borderRadius: 24,
                overflow: 'hidden',
                border: '2px solid #374151',
                flexShrink: 0,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt=""
                width={180}
                height={180}
                style={{ objectFit: 'cover' }}
              />
            </div>
          )}

          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              flex: 1,
            }}
          >
            <div style={{ fontSize: 56, fontWeight: 'bold', lineHeight: 1.1 }}>
              {title}
            </div>
            <div
              style={{
                fontSize: 22,
                color: '#9ca3af',
                lineHeight: 1.4,
                maxWidth: 700,
              }}
            >
              {description.length > 120
                ? description.slice(0, 120) + '…'
                : description}
            </div>
          </div>
        </div>

        {/* Stats bar — only for project cards */}
        {isProjectCard && (
          <div
            style={{
              display: 'flex',
              gap: 48,
              marginTop: 'auto',
              paddingTop: 32,
              borderTop: '1px solid #1f2937',
            }}
          >
            {healthScore && (
              <Stat
                label="Health"
                value={healthScore}
                color={healthScoreColor(Number(healthScore))}
              />
            )}
            {floorPrice && <Stat label="Floor" value={`${floorPrice} ETH`} />}
            {holders && <Stat label="Holders" value={formatNumber(holders)} />}
            {listed && <Stat label="Listed" value={`${listed}%`} />}
          </div>
        )}
      </div>
    ),
    { width: 1200, height: 630 },
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 14, color: '#6b7280', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 32, fontWeight: 'bold', color: color ?? 'white' }}>
        {value}
      </div>
    </div>
  );
}

function healthScoreColor(score: number): string {
  if (score >= 70) return '#22c55e';
  if (score >= 40) return '#eab308';
  return '#ef4444';
}

function formatNumber(n: string): string {
  const num = Number(n);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return n;
}
