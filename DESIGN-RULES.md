# Design Rules - NEXUS

## UI/UX Principles

### Never Use Native Browser Dialogs

**FORBIDDEN:**
- `window.alert()`
- `window.confirm()`
- `window.prompt()`

**WHY:**
- Blocks entire browser (can't interact with anything)
- Can't be styled to match design system
- Looks outdated and unprofessional
- Breaks user flow
- Can't be dismissed with ESC or click-away
- Mobile UX is terrible

**USE INSTEAD:**

#### Confirmations → Modal Dialogs
```tsx
// BAD:
const confirmed = window.confirm("Delete this collection?");

// GOOD:
<ConfirmModal
  isOpen={showDeleteModal}
  onClose={() => setShowDeleteModal(false)}
  onConfirm={handleDelete}
  title="Delete Collection?"
  message="This action cannot be undone."
  confirmText="Delete"
  confirmVariant="danger"
/>
```

#### Success/Error Messages → Toast Notifications
```tsx
// BAD:
alert("✅ Successfully indexed 247 holders!");

// GOOD:
toast.success("Successfully indexed 247 holders!");
// or
showToast({ type: 'success', message: '247 holders indexed' });
```

#### User Input → Modal with Form
```tsx
// BAD:
const projectId = window.prompt("Enter project ID:");

// GOOD:
<InputModal
  isOpen={showInputModal}
  onClose={() => setShowInputModal(false)}
  onSubmit={handleSubmit}
  title="Link to Project"
  label="Project ID"
  placeholder="abc-123-def"
/>
```

## Implementation Checklist

### Current Violations to Fix

**Admin Collections Page:**
- [ ] Replace `confirm()` for Index Holders
- [ ] Replace `confirm()` for Discover Collections
- [ ] Replace `alert()` for success messages
- [ ] Replace `alert()` for error messages
- [ ] Add toast notification system

**Other Pages:**
- [ ] Audit entire app for `window.alert/confirm/prompt`
- [ ] Replace all instances

### Required Components

**1. ConfirmModal Component**
```tsx
interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger' | 'warning';
}
```

**2. Toast System**
```tsx
interface ToastOptions {
  type: 'success' | 'error' | 'info' | 'warning';
  message: string;
  duration?: number; // auto-dismiss after N ms
}

toast.success(message);
toast.error(message);
toast.info(message);
toast.warning(message);
```

**3. InputModal Component** (for prompts)
```tsx
interface InputModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
  title: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
}
```

## Design System Integration

### Modal Styling
- Dark background overlay (rgba(0,0,0,0.7))
- Card with rounded corners, shadow
- ESC to close
- Click overlay to close
- Focus trap (can't tab out)
- Smooth enter/exit animations

### Toast Styling
- Bottom-right corner
- Stack multiple toasts
- Auto-dismiss after 5 seconds (configurable)
- Swipe to dismiss (mobile)
- Icon based on type (✓, ✗, ℹ, ⚠)
- Color-coded: green, red, blue, yellow

### Accessibility
- Modal: aria-modal="true", role="dialog"
- Toast: role="status" or role="alert"
- Focus management (return focus after close)
- Keyboard navigation (Tab, Enter, ESC)

## Libraries to Consider

**Option 1: Build Custom**
- Full control over design
- No extra dependencies
- More work upfront

**Option 2: Radix UI**
- Headless components (style yourself)
- Excellent accessibility
- No CSS opinions
- Recommended: `@radix-ui/react-dialog` + `@radix-ui/react-toast`

**Option 3: Headless UI**
- Built by Tailwind team
- Works great with Tailwind CSS
- `@headlessui/react` Dialog + Transition

**Option 4: Sonner**
- Best-in-class toast library
- Beautiful defaults
- Easy to customize
- `npm install sonner`

## Recommended Stack

```bash
npm install sonner @radix-ui/react-dialog
```

**For Toasts:** Sonner (easiest, best DX)
**For Modals:** Radix Dialog (flexible, accessible)

## Migration Strategy

1. **Phase 1:** Add toast system
   - Install Sonner
   - Add `<Toaster />` to layout
   - Create `useToast()` hook wrapper

2. **Phase 2:** Create ConfirmModal component
   - Build with Radix Dialog
   - Style to match design system
   - Add to component library

3. **Phase 3:** Replace existing dialogs
   - Search codebase for `window.alert/confirm/prompt`
   - Replace one page at a time
   - Test keyboard/screen reader accessibility

4. **Phase 4:** Document
   - Add examples to Storybook (if using)
   - Update component docs
   - Add to onboarding guide

## Enforcement

**ESLint Rule:**
```json
{
  "rules": {
    "no-restricted-globals": ["error", {
      "name": "alert",
      "message": "Use toast notifications instead"
    }, {
      "name": "confirm",
      "message": "Use ConfirmModal component instead"
    }, {
      "name": "prompt",
      "message": "Use InputModal component instead"
    }]
  }
}
```

Add this to `.eslintrc.json` to prevent future violations.

## Examples

### Before/After: Index Holders

**Before:**
```tsx
const confirmed = window.confirm(
  `Index all holders for ${collection.name}?\n\n` +
  `This will fetch data from ${apiSource}...`
);
if (!confirmed) return;

try {
  const result = await indexHolders(collection.id);
  alert(`✅ Successfully indexed ${result.count} holders!`);
} catch (err) {
  alert(`Error: ${err.message}`);
}
```

**After:**
```tsx
const [showIndexModal, setShowIndexModal] = useState(false);

// In render:
<ConfirmModal
  isOpen={showIndexModal}
  onClose={() => setShowIndexModal(false)}
  onConfirm={async () => {
    setShowIndexModal(false);
    try {
      const result = await indexHolders(collection.id);
      toast.success(`Successfully indexed ${result.count} holders`);
    } catch (err) {
      toast.error(err.message);
    }
  }}
  title="Index Holders"
  message={
    <>
      <p>Index all holders for <strong>{collection.name}</strong>?</p>
      <p className="mt-2 text-sm text-gray-400">
        This will fetch data from {apiSource} and may take several minutes.
      </p>
      <dl className="mt-3 text-sm">
        <dt className="text-gray-500">Chain:</dt>
        <dd>{collection.chain}</dd>
        <dt className="text-gray-500 mt-1">Contract:</dt>
        <dd className="font-mono text-xs">{collection.contractAddress}</dd>
      </dl>
    </>
  }
  confirmText="Index Holders"
  variant="default"
/>
```

## Notes

- Modals can contain rich content (formatted text, lists, etc.)
- Toasts are for quick feedback (success/error)
- Keep toast messages concise (< 80 chars)
- Use modals for anything requiring user decision
- Never block the UI with synchronous dialogs
