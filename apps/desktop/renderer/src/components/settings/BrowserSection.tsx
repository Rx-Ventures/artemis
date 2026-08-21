/**
 * Browser.
 * ============================================================================
 *
 * Whose browser the agent works in, and whose browser pages open in. Two
 * switches, one question each, and the question is the same one twice at
 * different strengths: *should web pages happen in the browser the user
 * actually lives in — their logins, their password manager, their tabs —
 * rather than in the embedded pane Artemis draws?*
 *
 * ---------------------------------------------------------------------------
 * WHY THE EMBEDDED BROWSER LOSES ON THE REAL WEB
 * ---------------------------------------------------------------------------
 *
 * The dock browser is a deliberately sandboxed `WebContentsView`: its own
 * cookie jar, every permission refused, popups denied, downloads blocked. That
 * is the right shape for previewing a dev server and the wrong shape for the
 * signed-in web — it starts logged out of everything, password managers cannot
 * reach into it, and Google-class sign-in flows refuse embedded browsers
 * outright. The way out is not to soften the sandbox; it is to use the
 * browser that already has the user's sessions. These switches are the two
 * routes there.
 *
 * ---------------------------------------------------------------------------
 * TWO SWITCHES, NOT ONE
 * ---------------------------------------------------------------------------
 *
 * They differ in what the agent can *do*, which is why they are not collapsed
 * into a three-way choice:
 *
 *  - **Chrome** hands the agent a two-way bridge (the Claude-in-Chrome
 *    extension): it opens tabs in the user's Chrome *and* can read, click and
 *    type there, in a tab group the user watches. Claude sessions only, and
 *    only when the profile is signed in — an API-key profile keeps the bridge
 *    off, a rule the CLI enforces and this pane only reports.
 *  - **Default browser** is one-way: pages the agent opens land in the user's
 *    default browser, and the agent is told it cannot see them. Works with
 *    every provider, grants nothing beyond "open a tab".
 *
 * When both are on, Chrome wins for the runs it applies to — it is the
 * stronger form of the same preference. The copy under each switch says so,
 * because a pair of toggles whose interaction is a surprise is a pane that
 * teaches distrust.
 *
 * Both apply from the next run, like everything in this dialog. The dialog's
 * own header says that once; it is not repeated per switch.
 */

import type { ReactElement } from 'react';

import { setAgentChrome, setOpenWebExternally, useApp } from '../../state/store';
import { SettingsGroup, SettingsPane } from './pane';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Switch } from '@/components/ui/switch';

export function BrowserSection(): ReactElement {
  const chrome = useApp((s) => s.agentChrome);
  const external = useApp((s) => s.openWebExternally);

  return (
    <SettingsPane
      title="Browser"
      description="Whose browser the agent works in, and where pages it opens for you land."
    >
      <SettingsGroup label="Agent browsing">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Browse with your Chrome</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Claude sessions drive your own Chrome through the Claude in Chrome extension: tabs
                open in a colour-coded group in your real browser, with your logins and your
                password manager, and the agent can read and act on what it opened while you keep
                using other tabs. Needs the extension installed and a profile signed in with an
                account — a profile using an API key keeps this off, silently, because the
                extension cannot authenticate with one. The embedded dock browser is not offered
                to these runs.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-agent-chrome"
                aria-label="Browse with your Chrome"
                checked={chrome}
                onCheckedChange={setAgentChrome}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>

      <SettingsGroup label="Pages opened for you">
        <ItemGroup className="gap-2">
          <Item variant="outline" size="sm" className="items-start border-line bg-panel">
            <ItemContent>
              <ItemTitle className="text-xs text-ink">Open pages in your default browser</ItemTitle>
              <ItemDescription className="line-clamp-none text-2xs leading-relaxed text-ink-faint">
                Previews and pages the agent opens land in your default browser — signed in,
                password manager and all — instead of the embedded dock browser. The agent keeps a
                way to show you a page and loses the ability to read or click it, so it is told to
                verify its work through logs and tests, or to ask you. Applies to every provider.
                When Chrome browsing above is on, Claude runs use that richer bridge instead.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                id="settings-open-web-externally"
                aria-label="Open pages in your default browser"
                checked={external}
                onCheckedChange={setOpenWebExternally}
              />
            </ItemActions>
          </Item>
        </ItemGroup>
      </SettingsGroup>
    </SettingsPane>
  );
}
