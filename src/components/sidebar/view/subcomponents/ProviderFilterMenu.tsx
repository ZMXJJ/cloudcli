import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ListFilter } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { LLMProvider } from '../../../../types/app';
import { SIDEBAR_PROVIDERS } from '../../../../utils/providerFilter';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

type ProviderFilterMenuProps = {
  selectedProviders: readonly LLMProvider[];
  onChange: (providers: LLMProvider[]) => void;
  t: TFunction;
  className?: string;
};

const MENU_WIDTH = 224;
const MENU_OFFSET = 8;
const VIEWPORT_MARGIN = 8;

type MenuPosition = {
  left: number;
  top: number;
  width: number;
};

export default function ProviderFilterMenu({
  selectedProviders,
  onChange,
  t,
  className,
}: ProviderFilterMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const isFiltered = selectedProviders.length < SIDEBAR_PROVIDERS.length;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideTrigger = rootRef.current?.contains(target) ?? false;
      const isInsideMenu = menuRef.current?.contains(target) ?? false;
      if (!isInsideTrigger && !isInsideMenu) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const width = Math.min(MENU_WIDTH, Math.max(0, window.innerWidth - VIEWPORT_MARGIN * 2));
      const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, triggerRect.right - width),
        maxLeft,
      );
      const menuHeight = menuRef.current?.offsetHeight ?? 0;
      const spaceBelow = window.innerHeight - triggerRect.bottom - VIEWPORT_MARGIN;
      const shouldOpenAbove = menuHeight > 0 && spaceBelow < menuHeight + MENU_OFFSET;
      const preferredTop = shouldOpenAbove
        ? triggerRect.top - menuHeight - MENU_OFFSET
        : triggerRect.bottom + MENU_OFFSET;
      const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - menuHeight - VIEWPORT_MARGIN);
      const top = Math.min(Math.max(VIEWPORT_MARGIN, preferredTop), maxTop);

      setMenuPosition({ left, top, width });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  const toggleProvider = (provider: LLMProvider) => {
    if (selectedProviders.includes(provider)) {
      if (selectedProviders.length === 1) {
        return;
      }
      onChange(selectedProviders.filter((candidate) => candidate !== provider));
      return;
    }

    onChange(SIDEBAR_PROVIDERS.filter(
      (candidate) => candidate === provider || selectedProviders.includes(candidate),
    ));
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(
          'relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent/80 hover:text-foreground',
          isOpen && 'bg-accent text-foreground',
        )}
        aria-label={t('providerFilter.title', 'Filter providers')}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        title={t('providerFilter.title', 'Filter providers')}
        onClick={() => setIsOpen((current) => !current)}
      >
        <ListFilter className="h-4 w-4" />
        {isFiltered && (
          <span className="absolute right-0.5 top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[8px] font-semibold leading-none text-primary-foreground ring-1 ring-background">
            {selectedProviders.length}
          </span>
        )}
      </button>

      {isOpen && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          className="fixed z-50 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
          style={{
            left: menuPosition?.left ?? VIEWPORT_MARGIN,
            top: menuPosition?.top ?? VIEWPORT_MARGIN,
            width: menuPosition?.width ?? MENU_WIDTH,
            visibility: menuPosition ? 'visible' : 'hidden',
          }}
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium">{t('providerFilter.title', 'Filter providers')}</span>
            <button
              type="button"
              className="text-[11px] text-muted-foreground hover:text-foreground disabled:cursor-default disabled:opacity-50"
              disabled={!isFiltered}
              onClick={() => onChange([...SIDEBAR_PROVIDERS])}
            >
              {t('providerFilter.selectAll', 'Select all')}
            </button>
          </div>
          <div className="p-1.5">
            {SIDEBAR_PROVIDERS.map((provider) => {
              const checked = selectedProviders.includes(provider);
              const disabled = checked && selectedProviders.length === 1;
              return (
                <button
                  key={provider}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  disabled={disabled}
                  className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-70"
                  onClick={() => toggleProvider(provider)}
                >
                  <span className={cn(
                    'flex h-4 w-4 items-center justify-center rounded border',
                    checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                  )}>
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <SessionProviderLogo provider={provider} className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate">
                    {t(`providerFilter.providers.${provider}`, provider)}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
            {t('providerFilter.minimumOne', 'Keep at least one provider selected.')}
          </p>
        </div>,
        document.body,
      )}
    </div>
  );
}
