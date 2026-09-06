import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';

import {
  buildChromeAppArgs,
  isWindowsChromiumProgId,
  launchPreview,
  linuxChromiumBinaryForDesktop,
  macChromiumExeForBundleId,
  parseWindowsCommandExe,
} from '../apps/manifold3d-mcp/src/server/preview/launch-browser.js';

const subprocess = vi.hoisted(() => ({
  execFile:
    vi.fn<
      (
        command: string,
        args: string[],
        options: ExecFileOptions,
        callback: (error: Error | null, stdout: string) => void,
      ) => ChildProcess
    >(),
  spawn: vi.fn<(command: string, args: string[], options: SpawnOptions) => ChildProcess>(),
}));

vi.mock('node:child_process', () => subprocess);
vi.mock('node:fs', () => ({ existsSync: () => true }));

function childProcess(): ChildProcess {
  return Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() }) as unknown as ChildProcess;
}

function probeOutput(command: string, chromium: boolean): string {
  switch (command) {
    case 'plutil':
      return JSON.stringify({
        LSHandlers: [
          { LSHandlerURLScheme: 'http', LSHandlerRoleAll: chromium ? 'com.google.chrome' : 'com.apple.Safari' },
        ],
      });
    case 'reg':
      return chromium
        ? 'ProgId REG_SZ ChromeHTML\n(Default) REG_SZ "C:\\Chrome\\chrome.exe" --single-argument %1'
        : 'ProgId REG_SZ FirefoxURL';
    case 'xdg-settings':
      return chromium ? 'google-chrome.desktop' : 'firefox.desktop';
    case 'which':
      return '/usr/bin/google-chrome';
    default:
      throw new Error(`Unexpected probe: ${command}`);
  }
}

function mockDetection(chromium: boolean): void {
  subprocess.execFile.mockImplementation((command, _args, _options, callback) => {
    const output =
      command === 'reg' && _args.includes('/ve')
        ? '(Default) REG_SZ "C:\\Chrome\\chrome.exe" --single-argument %1'
        : probeOutput(command, chromium);
    queueMicrotask(() => callback(null, output));
    return childProcess();
  });
}

describe('launchPreview lifecycle', () => {
  beforeEach(() => {
    subprocess.execFile.mockReset();
    subprocess.spawn.mockReset();
    vi.stubEnv('MANIFOLD_MCP_NO_OPEN', '');
    mockDetection(true);
    subprocess.spawn.mockImplementation(() => {
      const child = childProcess();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips probes and launch entirely when disabled or already cancelled', async () => {
    vi.stubEnv('MANIFOLD_MCP_NO_OPEN', '1');
    await launchPreview('http://localhost:1234');
    vi.stubEnv('MANIFOLD_MCP_NO_OPEN', '');
    await launchPreview('http://localhost:1234', { signal: AbortSignal.abort() });
    expect(subprocess.execFile).not.toHaveBeenCalled();
    expect(subprocess.spawn).not.toHaveBeenCalled();
  });

  it('bounds and cancels probes but hands off app windows without taking browser ownership', async () => {
    const controller = new AbortController();
    await launchPreview('http://localhost:1234', { signal: controller.signal });
    for (const call of subprocess.execFile.mock.calls) {
      expect(call[2]).toMatchObject({ timeout: 2_000, killSignal: 'SIGKILL' });
    }
    expect(subprocess.spawn).toHaveBeenCalledWith(expect.any(String), ['--app=http://localhost:1234'], {
      detached: true,
      stdio: 'ignore',
    });
    const browser = subprocess.spawn.mock.results[0]!.value as ChildProcess;
    controller.abort();
    expect(browser.unref).toHaveBeenCalledTimes(1);
    expect(browser.kill).not.toHaveBeenCalled();
  });

  it('opens the OS default browser for non-Chromium defaults', async () => {
    mockDetection(false);
    await launchPreview('http://localhost:1234');
    const command =
      process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'powershell.exe' : 'xdg-open';
    expect(subprocess.spawn).toHaveBeenCalledWith(command, expect.any(Array), { detached: true, stdio: 'ignore' });
  });

  it('logs detection failure and falls back without rejecting', async () => {
    const warn = vi.fn();
    subprocess.execFile.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(new Error('probe unavailable'), ''));
      return childProcess();
    });
    await expect(launchPreview('http://localhost:1234', { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('default browser detection failed: probe unavailable');
    expect(subprocess.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not launch when a probe reports success after cancellation', async () => {
    const controller = new AbortController();
    const callbacks: Array<() => void> = [];
    subprocess.execFile.mockImplementation((command, _args, _options, callback) => {
      callbacks.push(() => callback(null, probeOutput(command, true)));
      return childProcess();
    });
    const launching = launchPreview('http://localhost:1234', { signal: controller.signal });
    controller.abort();
    callbacks[0]!();
    await launching;
    expect(subprocess.execFile).toHaveBeenCalledTimes(1);
    expect(subprocess.spawn).not.toHaveBeenCalled();
  });

  it('does not attempt a late fallback when a cancelled app-window launch reports an error', async () => {
    const controller = new AbortController();
    const child = childProcess();
    subprocess.spawn.mockReturnValue(child);
    const launching = launchPreview('http://localhost:1234', { signal: controller.signal });
    await vi.waitFor(() => expect(subprocess.spawn).toHaveBeenCalledTimes(1));
    controller.abort();
    child.emit('error', new Error('spawn failed'));
    await launching;
    expect(subprocess.spawn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('logs failure of both browser handoffs without rejecting', async () => {
    const warn = vi.fn();
    subprocess.spawn.mockImplementation(() => {
      const child = childProcess();
      queueMicrotask(() => child.emit('error', new Error('cannot open')));
      return child;
    });
    await expect(launchPreview('http://localhost:1234', { warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('app-window launch failed: cannot open');
    expect(warn).toHaveBeenCalledWith('browser launch failed: cannot open');
  });

  it('reports an OS launcher nonzero exit after handoff without awaiting the process', async () => {
    const warn = vi.fn();
    mockDetection(false);
    await launchPreview('http://localhost:1234', { warn });
    const child = subprocess.spawn.mock.results[0]!.value as ChildProcess;
    child.emit('exit', 3);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/browser launch failed: .* exited with status 3/));
  });

  it.each(['cancel', 'timeout'] as const)('terminates a real stuck detection helper on %s', async mode => {
    const actual = await vi.importActual<typeof ChildProcessModule>('node:child_process');
    const controller = new AbortController();
    let helper: ChildProcess | undefined;
    let stopped: Promise<void> | undefined;
    subprocess.execFile.mockImplementation((_command, _args, options, callback) => {
      helper = actual.execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options, (error, stdout) =>
        callback(error, String(stdout)),
      );
      stopped = new Promise(resolve => helper!.once('close', () => resolve()));
      return helper;
    });
    const warn = vi.fn();
    const launching = launchPreview('http://localhost:1234', { signal: controller.signal, warn });
    try {
      expect(helper).toBeDefined();
      if (mode === 'cancel') {
        controller.abort();
      }
      await launching;
      await stopped;
      expect(helper!.killed).toBe(true);
      expect(helper!.signalCode).toBe('SIGKILL');
      expect(subprocess.spawn).toHaveBeenCalledTimes(mode === 'cancel' ? 0 : 1);
      expect(warn).toHaveBeenCalledTimes(mode === 'cancel' ? 0 : 1);
    } finally {
      helper?.kill('SIGKILL');
      await stopped;
    }
  });
});

describe('buildChromeAppArgs', () => {
  it('produces a single --app switch with the url', () => {
    expect(buildChromeAppArgs('http://localhost:1234/')).toEqual(['--app=http://localhost:1234/']);
  });
});

describe('macChromiumExeForBundleId', () => {
  it('maps Chrome and Edge bundle ids to executables', () => {
    expect(macChromiumExeForBundleId('com.google.Chrome')).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    expect(macChromiumExeForBundleId('com.microsoft.edgemac')).toBe(
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  });

  it('is case-insensitive (LaunchServices stores ids lowercased)', () => {
    expect(macChromiumExeForBundleId('COM.GOOGLE.CHROME')).toBe(macChromiumExeForBundleId('com.google.chrome'));
  });

  it('returns null for non-Chromium browsers', () => {
    expect(macChromiumExeForBundleId('com.apple.Safari')).toBeNull();
    expect(macChromiumExeForBundleId('org.mozilla.firefox')).toBeNull();
  });
});

describe('isWindowsChromiumProgId', () => {
  it('recognises Chromium http-handler ProgIds (case-insensitive)', () => {
    expect(isWindowsChromiumProgId('ChromeHTML')).toBe(true);
    expect(isWindowsChromiumProgId('MSEdgeHTM')).toBe(true);
    expect(isWindowsChromiumProgId('BraveHTML')).toBe(true);
    expect(isWindowsChromiumProgId('chromehtml-308...')).toBe(true);
  });

  it('rejects non-Chromium ProgIds', () => {
    expect(isWindowsChromiumProgId('FirefoxURL')).toBe(false);
    expect(isWindowsChromiumProgId('IE.HTTP')).toBe(false);
  });
});

describe('parseWindowsCommandExe', () => {
  it('extracts a quoted exe path', () => {
    expect(
      parseWindowsCommandExe('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1'),
    ).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  });

  it('extracts an unquoted exe path', () => {
    expect(parseWindowsCommandExe('C:\\Edge\\msedge.exe %1')).toBe('C:\\Edge\\msedge.exe');
  });

  it('returns null when no exe is present', () => {
    expect(parseWindowsCommandExe('garbage %1')).toBeNull();
  });
});

describe('linuxChromiumBinaryForDesktop', () => {
  it('maps known .desktop files to binaries (with or without suffix)', () => {
    expect(linuxChromiumBinaryForDesktop('google-chrome.desktop')).toBe('google-chrome');
    expect(linuxChromiumBinaryForDesktop('microsoft-edge')).toBe('microsoft-edge');
    expect(linuxChromiumBinaryForDesktop('brave-browser.desktop')).toBe('brave-browser');
  });

  it('returns null for non-Chromium browsers', () => {
    expect(linuxChromiumBinaryForDesktop('firefox.desktop')).toBeNull();
  });
});
