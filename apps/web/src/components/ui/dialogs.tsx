import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import * as Dialog from '@radix-ui/react-dialog';

/**
 * In-app replacements for window.confirm and window.prompt.
 *
 *   if (!(await confirmDialog({ title: 'Delete event?', variant: 'danger' }))) return;
 *   const name = await promptDialog({ title: 'Name this passkey', defaultValue: 'Laptop' });
 *
 * They work from anywhere, hooks or not, as long as <DialogHost /> is mounted once (it is, in
 * the root layout). Requests made while a dialog is open wait their turn. Changing page cancels
 * anything still open, so an answer can't act on a page that's gone.
 */

type Variant = 'default' | 'danger' | 'warning';

interface BaseOptions {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: Variant;
}

export type ConfirmOptions = BaseOptions;

export interface PromptOptions extends BaseOptions {
  /** Label shown above the text field. */
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  /** Keep the confirm button disabled while the field is blank. */
  required?: boolean;
  maxLength?: number;
  multiline?: boolean;
}

type Request =
  | { id: number; kind: 'confirm'; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { id: number; kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

let queue: Request[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function enqueue(request: Request) {
  queue = [...queue, request];
  emit();
}

function settle(id: number, value: boolean | string | null) {
  const request = queue.find((r) => r.id === id);
  if (!request) return;
  queue = queue.filter((r) => r.id !== id);
  emit();
  if (request.kind === 'confirm') request.resolve(value === true);
  else request.resolve(typeof value === 'string' ? value : null);
}

/** Cancels every open or waiting dialog. */
function cancelAll() {
  const pending = queue;
  if (pending.length === 0) return;
  queue = [];
  emit();
  for (const r of pending) {
    if (r.kind === 'confirm') r.resolve(false);
    else r.resolve(null);
  }
}

/** Asks a yes/no question. Resolves true on confirm, false on cancel, Escape or clicking away. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => enqueue({ id: nextId++, kind: 'confirm', options, resolve }));
}

/** Asks for a line of text. Resolves the text on confirm, or null on cancel. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => enqueue({ id: nextId++, kind: 'prompt', options, resolve }));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => queue[0];

const CONFIRM_BUTTON_STYLES: Record<Variant, string> = {
  default: 'bg-purple-600 hover:bg-purple-700',
  danger: 'bg-red-600 hover:bg-red-700',
  warning: 'bg-orange-600 hover:bg-orange-700',
};

const DIALOG_OVERLAY_CLASS = 'fixed inset-0 z-50 bg-black/70';
const DIALOG_CONTENT_CLASS =
  'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-gray-800 bg-gray-900 p-6 shadow-2xl';
const CANCEL_BUTTON_CLASS =
  'rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 hover:border-gray-600 hover:text-white disabled:opacity-50';
const CONFIRM_BUTTON_BASE = 'rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50';

/** Renders whichever dialog is first in line. Mount once, near the root. */
export function DialogHost() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { pathname } = useLocation();
  // Leaving the page (back button, redirect) or unmounting cancels pending dialogs.
  useEffect(() => cancelAll, [pathname]);
  if (!current) return null;
  // Keyed so each request starts with fresh field state.
  return <HostedDialog key={current.id} request={current} />;
}

function HostedDialog({ request }: { request: Request }) {
  const { options } = request;
  const isPrompt = request.kind === 'prompt';
  const promptOptions = isPrompt ? (request.options as PromptOptions) : undefined;
  const [value, setValue] = useState(promptOptions?.defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openedAt = useRef(Date.now());
  const blocked = Boolean(promptOptions?.required && !value.trim());

  const cancel = () => settle(request.id, isPrompt ? null : false);
  const submit = () => {
    if (blocked) return;
    settle(request.id, isPrompt ? value : true);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY_CLASS} />
        <Dialog.Content
          className={DIALOG_CONTENT_CLASS}
          onOpenAutoFocus={(e) => {
            // Prompts focus the field. Confirms focus the confirm button, except dangerous ones,
            // which focus Cancel so a stray Enter doesn't delete anything.
            e.preventDefault();
            // The default text is selected so typing replaces it, as window.prompt does.
            if (isPrompt) {
              inputRef.current?.focus();
              inputRef.current?.select();
            }
            else (options.variant === 'danger' ? cancelRef : confirmRef).current?.focus();
          }}
          onPointerDownOutside={(e) => {
            // The second click of a double-click on the button that opened this lands on the
            // overlay; don't let it count as clicking away.
            if (Date.now() - openedAt.current < 400) e.preventDefault();
          }}
          {...(options.message ? {} : { 'aria-describedby': undefined })}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Dialog.Title className="text-xl font-semibold text-white">{options.title}</Dialog.Title>

            {options.message && (
              <Dialog.Description asChild>
                <div className="mt-4 whitespace-pre-line text-gray-300">{options.message}</div>
              </Dialog.Description>
            )}

            {promptOptions && (
              <label className="mt-4 block">
                {promptOptions.label && (
                  <span className="mb-1 block text-sm text-gray-400">{promptOptions.label}</span>
                )}
                {promptOptions.multiline ? (
                  <textarea
                    ref={inputRef}
                    rows={3}
                    value={value}
                    maxLength={promptOptions.maxLength}
                    placeholder={promptOptions.placeholder}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        submit();
                      }
                    }}
                    className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
                  />
                ) : (
                  <input
                    ref={inputRef}
                    type="text"
                    value={value}
                    maxLength={promptOptions.maxLength}
                    placeholder={promptOptions.placeholder}
                    onChange={(e) => setValue(e.target.value)}
                    className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white placeholder-gray-500 focus:border-purple-500 focus:outline-none"
                  />
                )}
              </label>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button ref={cancelRef} type="button" onClick={cancel} className={CANCEL_BUTTON_CLASS}>
                {options.cancelText ?? 'Cancel'}
              </button>
              <button
                ref={confirmRef}
                type="submit"
                disabled={blocked}
                className={`${CONFIRM_BUTTON_BASE} ${CONFIRM_BUTTON_STYLES[options.variant ?? 'default']}`}
              >
                {options.confirmText ?? (isPrompt ? 'Save' : 'Confirm')}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
