/**
 * The design system, on one page.
 *
 * Every shared primitive rendered at once, so a change to `index.css` can be
 * judged rather than guessed at, and so whoever builds a feature screen can
 * see what they already have instead of rebuilding it.
 *
 * Dev-server only. `electron.vite.config.ts` builds `index.html` as the
 * renderer's single input, so `preview.html` and this file are never bundled
 * into the app. Nothing here may import application state — the gallery has to
 * render with no bridge, no store and no run.
 */

import type { ReactElement, ReactNode } from 'react';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import {
  BookOpenIcon,
  CircleStopIcon,
  CopyIcon,
  GitForkIcon,
  PlayIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
} from 'lucide-react';

import { ArtemisProviders } from './components/providers';
import { IconButton, ReasonButton, WithReason } from './components/disabled-reason';
import { CodeBlock, Row, StatusDot, ToneBadge, type Tone } from './components/primitives';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import './index.css';

/* -------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="chrome-label text-ink-faint">{title}</h2>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel p-4">
        {children}
      </div>
    </section>
  );
}

const TONES: readonly Tone[] = ['neutral', 'beam', 'cyan', 'sage', 'mint', 'amber', 'signal'];

const SWATCHES: readonly (readonly [string, string])[] = [
  ['abyss', 'bg-abyss'],
  ['panel', 'bg-panel'],
  ['raised', 'bg-raised'],
  ['float', 'bg-float'],
  ['inset', 'bg-inset'],
  ['line', 'bg-line'],
  ['beam', 'bg-beam'],
  ['cyan', 'bg-cyan'],
  ['sage', 'bg-sage'],
  ['mint', 'bg-mint'],
  ['amber', 'bg-amber'],
  ['signal', 'bg-signal'],
];

function Gallery(): ReactElement {
  const [checked, setChecked] = useState(true);

  return (
    <div className="h-full overflow-auto bg-abyss">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight text-ink">Artemis design system</h1>
          <p className="text-sm text-ink-muted">
            One plane and a hairline. Nothing is lighter because it is nearer.
          </p>
        </header>

        <Section title="Palette">
          {SWATCHES.map(([name, cls]) => (
            <div key={name} className="flex w-20 flex-col gap-1">
              <div className={`h-10 rounded-md border border-line ${cls}`} />
              <span className="font-mono text-2xs text-ink-faint">{name}</span>
            </div>
          ))}
        </Section>

        <Section title="Button — variants">
          <Button>Start run</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button variant="link">Link</Button>
        </Section>

        <Section title="Button — sizes">
          <Button size="xs">xs</Button>
          <Button size="sm">sm</Button>
          <Button size="default">default</Button>
          <Button size="lg">lg</Button>
          <Button size="icon-xs" aria-label="Play">
            <PlayIcon />
          </Button>
          <Button size="icon-sm" aria-label="Stop">
            <CircleStopIcon />
          </Button>
          <Button size="icon" aria-label="Settings">
            <SettingsIcon />
          </Button>
        </Section>

        <Section title="Disabled, with a reason — hover or Tab onto these">
          <ReasonButton onClick={() => toast.success('Run started')}>Enabled</ReasonButton>
          {/* The reason names the *provider*, which is what `useCapability`
              generates at runtime — never Anthropic's product name. */}
          <ReasonButton disabled disabledReason="Codex does not support forking a session.">
            <GitForkIcon />
            Fork
          </ReasonButton>
          <ReasonButton
            variant="destructive"
            disabled
            disabledReason="A run is in flight. Stop it before deleting the profile."
          >
            <TrashIcon />
            Delete
          </ReasonButton>
          <ReasonButton disabled>Disabled, unexplained</ReasonButton>
          <IconButton label="Copy run id">
            <CopyIcon />
          </IconButton>
          <IconButton
            label="Fork"
            disabled
            disabledReason="No provider is available yet, so forking a session is unavailable."
          >
            <GitForkIcon />
          </IconButton>
          <WithReason reason="The active provider has no permission modes to choose from.">
            <Switch disabled />
          </WithReason>
        </Section>

        <Section title="Badges and tones">
          <Badge>default</Badge>
          <Badge variant="secondary">secondary</Badge>
          <Badge variant="outline">outline</Badge>
          <Badge variant="destructive">destructive</Badge>
          <Separator orientation="vertical" className="mx-2 h-5" />
          {TONES.map((tone) => (
            <ToneBadge key={tone} tone={tone}>
              {tone}
            </ToneBadge>
          ))}
          <Separator orientation="vertical" className="mx-2 h-5" />
          {TONES.map((tone) => (
            <StatusDot key={tone} tone={tone} />
          ))}
          <StatusDot tone="beam" pulse />
        </Section>

        <Section title="Form controls">
          <div className="grid w-full grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="p-label">Label</FieldLabel>
              <Input id="p-label" placeholder="Work laptop" />
              <FieldDescription>Shown in the profile switcher.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="p-key">API key</FieldLabel>
              <Input id="p-key" type="password" defaultValue="sk-ant-0000" className="font-mono" />
              <FieldDescription>Never leaves the main process.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="p-mode">Permission mode</FieldLabel>
              <Select defaultValue="ask">
                <SelectTrigger id="p-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">Ask every time</SelectItem>
                  <SelectItem value="accept-edits">Accept edits</SelectItem>
                  <SelectItem value="bypass">Bypass all</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="p-prompt">System prompt</FieldLabel>
              <Textarea id="p-prompt" placeholder="Optional…" className="font-mono" />
            </Field>
            <div className="flex items-center gap-2">
              <Switch id="p-stream" checked={checked} onCheckedChange={setChecked} />
              <Label htmlFor="p-stream">Stream partial messages</Label>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-ink-muted">Focus the composer</span>
              <KbdGroup>
                <Kbd>⌘</Kbd>
                <Kbd>K</Kbd>
              </KbdGroup>
            </div>
          </div>
        </Section>

        <Section title="Overlays">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Allow this tool call?</DialogTitle>
                <DialogDescription>
                  The agent wants to run <code className="font-mono text-cyan">rm -rf ./build</code>{' '}
                  in the workspace root.
                </DialogDescription>
              </DialogHeader>
              <CodeBlock text={'$ rm -rf ./build\n# removes 1,204 files'} />
              <DialogFooter>
                <Button variant="ghost">Deny</Button>
                <Button>Allow once</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">Dropdown</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Profile</DropdownMenuLabel>
              <DropdownMenuItem>Switch…</DropdownMenuItem>
              <DropdownMenuItem>Duplicate</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" onClick={() => toast('Run finished', { description: '4.2s · 1,882 tokens' })}>
            Toast
          </Button>
          <Button variant="outline" onClick={() => toast.error('The provider rejected the request.')}>
            Error toast
          </Button>
        </Section>

        <Section title="Command palette">
          <Command className="w-full max-w-md border border-line">
            <CommandInput placeholder="Jump to…" />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              <CommandGroup heading="Runs">
                <CommandItem>
                  <PlayIcon />
                  Start a run
                </CommandItem>
                <CommandItem>
                  <SearchIcon />
                  Search the transcript
                </CommandItem>
                <CommandItem>
                  <BookOpenIcon />
                  Open the session list
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </Section>

        <Section title="Structure">
          <div className="grid w-full grid-cols-2 gap-4">
            <div className="overflow-hidden rounded-lg border border-line bg-panel">
              <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-2.5">
                <h3 className="chrome-label text-ink-faint">
                  Run details
                </h3>
                <IconButton label="Copy">
                  <CopyIcon />
                </IconButton>
              </div>
              <div className="p-2.5">
                <Row label="Run">01JD8K2QW9</Row>
                {/* "Claude", not "Claude Code": Artemis names the provider, never
                    Anthropic's product. */}
                <Row label="Provider" mono={false}>
                  Claude
                </Row>
                <Row label="Tokens">1,882 in / 402 out</Row>
              </div>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Card</CardTitle>
                <CardDescription>Chrome surface, hairline border.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>

            <Tabs defaultValue="transcript">
              <TabsList>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
                <TabsTrigger value="raw">Raw</TabsTrigger>
                <TabsTrigger value="usage">Usage</TabsTrigger>
              </TabsList>
              <TabsContent value="transcript" className="pt-2 text-sm text-ink-muted">
                Rendered assistant output.
              </TabsContent>
              <TabsContent value="raw" className="pt-2">
                <CodeBlock text={'{ "type": "assistant", "delta": "…" }'} />
              </TabsContent>
              <TabsContent value="usage" className="pt-2 text-sm text-ink-muted">
                1,882 in / 402 out
              </TabsContent>
            </Tabs>

            <Collapsible className="rounded-lg border border-line bg-raised/40 p-2.5">
              <CollapsibleTrigger className="text-xs text-ink-muted hover:text-ink">
                Thinking (3 blocks)
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2">
                <p className="font-mono text-2xs text-sage">
                  Checking whether the build already covers this…
                </p>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </Section>

        <Section title="Feedback">
          <div className="flex w-full flex-col gap-3">
            <Alert>
              <AlertTitle>Running in mock mode</AlertTitle>
              <AlertDescription>
                No preload bridge was found, so a scripted fake is standing in.
              </AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertTitle>The run ended unexpectedly</AlertTitle>
              <AlertDescription>The provider closed the stream after 4.2s.</AlertDescription>
            </Alert>
            <CodeBlock tone="error" text={'Error: ENOENT: no such file or directory\n    at open (fs.js:12)'} />
            <ScrollArea className="h-24 rounded-md border border-line bg-inset p-2.5">
              <p className="font-mono text-2xs whitespace-pre-line text-ink-muted">
                {Array.from({ length: 20 }, (_, i) => `line ${i + 1} of scrollable output`).join(
                  '\n',
                )}
              </p>
            </ScrollArea>
          </div>
        </Section>

        <Section title="Typography">
          <div className="flex w-full flex-col gap-1">
            <p className="text-xl text-ink">text-xl · 20px · chrome headings</p>
            <p className="text-lg text-ink">text-lg · 16px</p>
            <p className="text-base text-ink">text-base · 14px · body</p>
            <p className="text-sm text-ink-muted">text-sm · 13px · transcript</p>
            <p className="text-xs text-ink-muted">text-xs · 12px · controls</p>
            <p className="text-2xs text-ink-faint">text-2xs · 11px · chrome labels</p>
            <p className="text-sm text-ink">Geist · prose — prompts, answers, thinking</p>
            <p className="font-mono text-sm text-ink">Geist Mono · code, paths, chrome labels</p>
          </div>
        </Section>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Artemis preview: #root is missing from preview.html');

createRoot(container).render(
  <StrictMode>
    <ArtemisProviders>
      <Gallery />
    </ArtemisProviders>
  </StrictMode>,
);
