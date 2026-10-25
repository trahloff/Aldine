import { APPEARANCES, setAppearance, useAppearance, useTheme, type Appearance } from '../theme';
import type { Command } from './CommandPalette';
import { MenuButton, type MenuEntry } from './Menu';
import { IconMonitor, IconMoon, IconSun } from './Icons';

const ICON: Record<Appearance, typeof IconSun> = { system: IconMonitor, light: IconSun, dark: IconMoon };

/** Match system / Light / Dark as menu choices, the current one checked. */
export function appearanceMenuItems(current: Appearance): MenuEntry[] {
  return APPEARANCES.map(({ id, label }) => {
    const Icon = ICON[id];
    return { id: `appearance-${id}`, label, icon: <Icon />, checked: current === id, onSelect: () => setAppearance(id), testId: `appearance-${id}` };
  });
}

/** The same choices for the command palette, under "Appearance". */
export function appearanceCommands(current: Appearance): Command[] {
  return APPEARANCES.map(({ id, label }) => ({
    id: `appearance-${id}`,
    group: 'Appearance',
    title: label,
    keywords: 'theme appearance light dark system mode',
    hint: current === id ? 'Current' : undefined,
    run: () => setAppearance(id),
  }));
}

/** A toolbar button showing what is on screen, with the three choices in its menu. */
export function AppearanceMenuButton({ testId = 'theme-toggle', className = 'btn btn--icon' }: { testId?: string; className?: string }) {
  const appearance = useAppearance();
  const theme = useTheme();
  const Icon = appearance === 'system' ? IconMonitor : theme === 'dark' ? IconMoon : IconSun;
  return (
    <MenuButton
      items={() => appearanceMenuItems(appearance)}
      label="Appearance"
      ariaLabel="Appearance"
      title="Appearance"
      className={className}
      testId={testId}
      menuTestId="appearance-menu"
      placement="bottom-end"
    >
      <Icon width={16} height={16} />
    </MenuButton>
  );
}
