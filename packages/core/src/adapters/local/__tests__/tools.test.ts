/**
 * The tools, and the rule that keeps an agent working.
 *
 * The behaviour asserted most often below is that a tool *never throws*. A
 * thrown error ends the run; a returned failure is something the model reads
 * and corrects. An agent whose every mistake is fatal cannot do the job, so
 * each failure path here is checked to be a result rather than an exception.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ALL_TOOLS,
  executeTool,
  LIST_FILES,
  READ_FILE,
  SEARCH,
  SHELL,
  toolsForRisk,
  toWireTools,
  WRITE_FILE,
} from '../tools.js';
import type { ToolContext } from '../tools.js';

let base: string;
let root: string;
let ctx: ToolContext;
let shellCalls: string[];

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'artemis-tools-')));
  // The root is a *subdirectory* of the scratch area, so `base` gives the tests
  // somewhere genuinely outside it to aim at. Making them the same would have
  // every escape test pass by writing inside the sandbox.
  root = path.join(base, 'project');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'const one = 1;\nconst two = 2;\n');
  await writeFile(path.join(root, 'README.md'), '# Title\nneedle here\n');

  shellCalls = [];
  ctx = {
    root,
    env: {},
    signal: new AbortController().signal,
    shell: async (command) => {
      shellCalls.push(command);
      return { output: `ran: ${command}` };
    },
  };
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('the tool set', () => {
  it('declares risk rather than inferring it from the name', () => {
    expect(READ_FILE.risk).toBe('read');
    expect(WRITE_FILE.risk).toBe('write');
    expect(SHELL.risk).toBe('execute');
  });

  it('marks only the shell as needing the operating system to defend it', () => {
    // `confine` is a complete defence for tools Artemis performs itself; it is
    // no defence at all for a string handed to /bin/sh.
    expect(ALL_TOOLS.filter((t) => t.needsOsSandbox).map((t) => t.name)).toEqual([SHELL.name]);
  });

  it('offers only read tools when writing and executing are forbidden', () => {
    expect(toolsForRisk(false, false).map((t) => t.name)).toEqual([
      READ_FILE.name,
      LIST_FILES.name,
      SEARCH.name,
    ]);
  });

  it('adds writing and the shell as the sandbox permits them', () => {
    expect(toolsForRisk(true, false).map((t) => t.name)).toContain(WRITE_FILE.name);
    expect(toolsForRisk(true, false).map((t) => t.name)).not.toContain(SHELL.name);
    expect(toolsForRisk(true, true).map((t) => t.name)).toContain(SHELL.name);
  });

  it('serialises to the shape a chat-completions request expects', () => {
    const [first] = toWireTools([READ_FILE]);

    expect(first).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: READ_FILE.description,
        parameters: READ_FILE.parameters,
      },
    });
  });
});

describe('read_file', () => {
  it('numbers lines, because the model describes edits by line', async () => {
    const result = await executeTool('read_file', '{"path":"src/a.ts"}', ctx);

    expect(result.output).toContain('    1\tconst one = 1;');
    expect(result.output).toContain('    2\tconst two = 2;');
  });

  it('SANDBOX: refuses a path outside the root, as a result not a throw', async () => {
    const result = await executeTool('read_file', '{"path":"../../etc/passwd"}', ctx);

    expect(result.failed).toBe(true);
    expect(result.output).toMatch(/outside this run's directory/);
  });

  it('SANDBOX: refuses a symlink pointing out', async () => {
    // Aimed at a directory that exists and holds the file being asked for, so
    // the refusal is the sandbox's and not a missing target's — and made with a
    // junction on Windows, where a directory symlink needs a privilege an
    // ordinary user does not have.
    const secrets = path.join(base, 'secrets');
    await mkdir(secrets, { recursive: true });
    await writeFile(path.join(secrets, 'passwd'), 'root:x:0:0');
    await symlink(
      secrets,
      path.join(root, 'escape'),
      process.platform === 'win32' ? 'junction' : undefined,
    );

    const result = await executeTool('read_file', '{"path":"escape/passwd"}', ctx);

    expect(result.failed).toBe(true);
    expect(result.output).toMatch(/outside this run's directory/);
  });

  it('reports a missing file to the model rather than ending the run', async () => {
    const result = await executeTool('read_file', '{"path":"nope.ts"}', ctx);

    expect(result.failed).toBe(true);
    expect(result.output).toMatch(/ENOENT|no such file/i);
  });
});

describe('write_file', () => {
  it('writes inside the root and says what it did', async () => {
    const result = await executeTool('write_file', '{"path":"src/b.ts","content":"export {}"}', ctx);

    expect(result.failed).toBeUndefined();
    expect(await readFile(path.join(root, 'src', 'b.ts'), 'utf8')).toBe('export {}');
  });

  it('creates parent directories rather than failing on a new folder', async () => {
    await executeTool('write_file', '{"path":"deep/new/dir/f.txt","content":"hi"}', ctx);

    expect(await readFile(path.join(root, 'deep/new/dir/f.txt'), 'utf8')).toBe('hi');
  });

  it('SANDBOX: refuses to write outside the root', async () => {
    const escape = path.join(base, 'outside.txt');
    const result = await executeTool(
      'write_file',
      JSON.stringify({ path: escape, content: 'pwned' }),
      ctx,
    );

    expect(result.failed).toBe(true);
    await expect(readFile(escape, 'utf8')).rejects.toThrow();
  });

  it('refuses a missing content argument as a result', async () => {
    const result = await executeTool('write_file', '{"path":"x.txt"}', ctx);

    expect(result.failed).toBe(true);
    expect(result.output).toMatch(/content/);
  });
});

describe('list_files', () => {
  it('lists the root by default and marks directories', async () => {
    const result = await executeTool('list_files', '{}', ctx);

    expect(result.output).toContain('src/');
    expect(result.output).toContain('README.md');
  });

  it('says a directory is empty rather than returning nothing', async () => {
    await mkdir(path.join(root, 'empty'));

    expect((await executeTool('list_files', '{"path":"empty"}', ctx)).output).toMatch(/empty/);
  });
});

describe('search', () => {
  it('finds a literal string with its file and line', async () => {
    const result = await executeTool('search', '{"pattern":"needle"}', ctx);

    expect(result.output).toContain('README.md');
    expect(result.output).toContain('needle here');
  });

  it('NO-MATCH: reports no matches as an answer, not a failure', async () => {
    // grep exits 1 for no matches. Reporting that as a failure would have the
    // model retry a search that worked perfectly.
    const result = await executeTool('search', '{"pattern":"absolutely-not-present"}', ctx);

    expect(result.failed).toBeUndefined();
    expect(result.output).toMatch(/No matches/);
  });

  it('treats the pattern literally, so a stray regex character is not a syntax error', async () => {
    await writeFile(path.join(root, 'chars.txt'), 'a+b(c)\n');

    const result = await executeTool('search', '{"pattern":"a+b(c)"}', ctx);

    expect(result.output).toContain('chars.txt');
  });
});

describe('shell', () => {
  it('delegates to the injected runner rather than executing directly', async () => {
    // Injected so the sandbox decision stays at the call site, where the
    // approval policy can see it.
    const result = await executeTool('shell', '{"command":"echo hi"}', ctx);

    expect(shellCalls).toEqual(['echo hi']);
    expect(result.output).toBe('ran: echo hi');
  });

  it('refuses a missing command as a result', async () => {
    expect((await executeTool('shell', '{}', ctx)).failed).toBe(true);
    expect(shellCalls).toEqual([]);
  });
});

describe('additional directories — reading beyond the working directory', () => {
  // The shape of the bug this fixes: a team memory bank kept outside cwd that a
  // local model must be able to read. Granted read-only, so a read lands and a
  // write does not.
  let bank: string;
  let bankCtx: ToolContext;

  beforeEach(async () => {
    bank = path.join(base, 'cortex');
    await mkdir(path.join(bank, 'notes'), { recursive: true });
    await writeFile(path.join(bank, 'notes', 'memory.md'), 'needle in the bank\n');
    bankCtx = { ...ctx, additionalRoots: [{ path: bank, writable: false }] };
  });

  it('reads a file inside the additional directory by absolute path', async () => {
    const result = await executeTool(
      'read_file',
      JSON.stringify({ path: path.join(bank, 'notes', 'memory.md') }),
      bankCtx,
    );

    expect(result.failed).toBeUndefined();
    expect(result.output).toContain('needle in the bank');
  });

  it('lists the additional directory', async () => {
    const result = await executeTool('list_files', JSON.stringify({ path: bank }), bankCtx);

    expect(result.output).toContain('notes/');
  });

  it('READ-ONLY: refuses to write into the additional directory, as a result not a throw', async () => {
    const target = path.join(bank, 'notes', 'memory.md');
    const result = await executeTool(
      'write_file',
      JSON.stringify({ path: target, content: 'tampered' }),
      bankCtx,
    );

    expect(result.failed).toBe(true);
    expect(result.output).toMatch(/read-only additional directory/);
    // The refusal is real: the file the model tried to overwrite is untouched.
    expect(await readFile(target, 'utf8')).toBe('needle in the bank\n');
  });

  it('still writes inside the working directory when extra roots are present', async () => {
    const result = await executeTool(
      'write_file',
      '{"path":"src/b.ts","content":"export {}"}',
      bankCtx,
    );

    expect(result.failed).toBeUndefined();
    expect(await readFile(path.join(root, 'src', 'b.ts'), 'utf8')).toBe('export {}');
  });

  it('SANDBOX: a path outside both the working directory and the bank is still refused', async () => {
    const result = await executeTool(
      'read_file',
      JSON.stringify({ path: path.join(base, 'nope', 'secret.txt') }),
      bankCtx,
    );

    expect(result.failed).toBe(true);
  });
});

describe('executeTool — the rule that keeps an agent working', () => {
  it('MALFORMED: tells the model its JSON was broken instead of throwing', async () => {
    // Small models emit malformed arguments often enough that this is a normal
    // path. Telling the model is how it gets corrected.
    const result = await executeTool('read_file', '{"path": broken', ctx);

    expect(result.failed).toBe(true);
    expect(result.output).toMatch(/Could not parse/);
  });

  it('names an unknown tool rather than failing the run', async () => {
    const result = await executeTool('rm_rf', '{}', ctx);

    expect(result.failed).toBe(true);
    expect(result.output).toMatch(/No tool called "rm_rf"/);
  });

  it('never throws, for any tool, on any bad input', async () => {
    for (const tool of ALL_TOOLS) {
      await expect(executeTool(tool.name, '{}', ctx)).resolves.toBeDefined();
      await expect(executeTool(tool.name, 'not json', ctx)).resolves.toBeDefined();
      await expect(executeTool(tool.name, '{"path":"../../.."}', ctx)).resolves.toBeDefined();
    }
  });

  it('truncates output with a stated count rather than blowing the context', async () => {
    await writeFile(path.join(root, 'big.txt'), 'x'.repeat(80_000));

    const result = await executeTool('read_file', '{"path":"big.txt"}', ctx);

    expect(result.output).toMatch(/\[truncated — \d+ more characters\]/);
    expect(result.output.length).toBeLessThan(40_000);
  });
});
