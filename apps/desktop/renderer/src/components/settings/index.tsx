/**
 * The settings surface, as the rest of the app sees it.
 *
 * `App.tsx` imports exactly one thing — `SettingsDialog` — and renders it
 * unconditionally: the dialog reads its own open state off the store, so no
 * caller has to know that "settings is open" is spelled `screen === 'profiles'`
 * for historical reasons.
 *
 * The panes are exported too, but only for a caller that wants to embed one
 * (the design-system gallery does). Nothing outside this directory should need
 * them, and nothing should reach past this file into a pane's module path —
 * that is what keeps the section list, the nav and the dialog frame free to
 * change together.
 */

export { SettingsDialog } from './SettingsDialog';
export { ModelsSection } from './ModelsSection';
export { AppearanceSection } from './AppearanceSection';
export { PermissionsSection } from './PermissionsSection';
export { AdvancedSection } from './AdvancedSection';
export { ProfilesSection } from '../ProfilesScreen';
