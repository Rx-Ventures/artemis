/**
 * Instructions — everything the agent is told before the conversation starts.
 * ============================================================================
 *
 * Two libraries, one pane. The standing prompts are the general case: text the
 * user wrote, appended to the system prompt of every run it is scoped to. The
 * memory banks are the best-known instance of the same idea — durable facts,
 * maintained by agents and reviewed like code, installed into the same
 * briefing. They were separate panes once, and the nav comment that ordered
 * them said the quiet part: a user who meets a bank first has met an example
 * without the rule. Putting the rule and the instance on one surface, in that
 * order, is that comment finishing its own argument.
 *
 * The seam is deliberate and thin. Each half keeps its own module —
 * `AgentsSection.tsx` for the prompts, `MemoryBanksSection.tsx` for the banks,
 * both named for the frozen section ids that resolve here — and this file owns
 * only what the merge creates: the shared title row (the prompts' save state
 * and the banks' sync button are both whole-pane concerns now), the one
 * `useMemoryBanks` reading both halves answer from, and the rule under the
 * banks heading that says how the two relate.
 */

import type { ReactElement } from 'react';

import { useAgentPrompts } from '../../hooks/useAgentPrompts';
import { banksAvailability, useMemoryBanks } from '../../hooks/useMemoryBanks';
import { AgentPromptsGroups, SaveIndicator } from './AgentsSection';
import { MemoryBankGroups, SyncAllButton } from './MemoryBanksSection';
import { SettingsPane } from './pane';

export function InstructionsSection(): ReactElement {
  const prompts = useAgentPrompts();
  const banks = useMemoryBanks();

  return (
    <SettingsPane
      title="Instructions"
      description="What the agent is told before the conversation starts: prompts you write once and every run carries, and memory banks the agents maintain themselves."
      actions={
        <>
          <SaveIndicator pane={prompts} />
          <SyncAllButton pane={banks} />
        </>
      }
    >
      <AgentPromptsGroups pane={prompts} banksAvailable={banksAvailability(banks.status)} />

      {/*
        The banks under their own rule-line rather than as a fourth prompts
        group: they arrive with their own groups (the master gate, the bank
        cards, onboarding), and a reader scanning the pane needs the seam
        marked — everything above it is text sent verbatim, everything below
        is a repository consulted. The anchor is the address the palette's
        Memory-banks row scrolls to.
      */}
      <div data-settings-row="memory-banks" className="flex flex-col gap-5">
        <div className="flex flex-col gap-1 border-t border-line pt-4">
          <h3 className="chrome-label text-ink-faint">Memory banks</h3>
          <p className="text-2xs leading-relaxed text-ink-faint">
            The prompts above are instructions you state; the banks are the instance agents keep
            for themselves — shared git repositories of durable facts, reviewed like code and
            installed into every session&rsquo;s memory. The built-in prompt above is what tells
            the agent they exist.
          </p>
        </div>
        <MemoryBankGroups pane={banks} />
      </div>
    </SettingsPane>
  );
}
