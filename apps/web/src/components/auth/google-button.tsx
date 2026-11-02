import { useEffect, useRef, useState } from 'react';

interface GoogleIdApi {
  initialize: (config: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup' }) => void;
  renderButton: (el: HTMLElement, options: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleIdApi } };
  }
}

const SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
let scriptPromise: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Could not load Google sign-in'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/** Google's own "Sign in with Google" button. Hands back the ID token to send to the API. */
export function GoogleButton({
  clientId,
  onCredential,
  text = 'continue_with',
}: {
  clientId: string;
  onCredential: (credential: string) => void;
  text?: 'continue_with' | 'signin_with' | 'signup_with';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadGoogleScript()
      .then(() => {
        if (!live || !ref.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (r) => callback.current(r.credential),
          ux_mode: 'popup',
        });
        window.google.accounts.id.renderButton(ref.current, {
          theme: 'filled_black',
          size: 'large',
          shape: 'pill',
          text,
          width: 320,
        });
      })
      .catch((err) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [clientId, text]);

  return (
    <div>
      <div ref={ref} className="flex min-h-[44px] justify-center" />
      {error && <p className="mt-1 text-center text-xs text-red-400">{error}</p>}
    </div>
  );
}
