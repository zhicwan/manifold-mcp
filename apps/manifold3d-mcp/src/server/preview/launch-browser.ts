/**
 * Opens the preview URL in the user's browser, preferring a chromeless
 * "app window" when the user's *default* browser is Chromium-based
 * (Chrome / Edge / Chromium / Brave / Vivaldi …). Those browsers accept the
 * `--app=<url>` switch, which yields a PWA-like window with no address bar,
 * tabs, or toolbar.
 *
 * Design rules (see plan):
 *  - **Respect the default browser.** We never force a different browser on
 *    the user. We only upgrade to an app window when the OS default handler
 *    for `http` is itself a Chromium browser we can locate.
 *  - **Fall back to the OS URL launcher** (a normal tab in the default browser) when
 *    the default is Safari / Firefox / unknown, or detection/spawn fails.
 *    Safari and Firefox have no `--app` equivalent — that is a platform
 *    limitation, not something we can work around.
 *  - **`MANIFOLD_MCP_NO_OPEN`** skips everything (used by tests / headless CI).
 *
 * The pure mapping helpers (identifier -> candidate executable) are exported
 * so they can be unit-tested without spawning a real browser.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const BROWSER_PROBE_TIMEOUT_MS = 2_000;

export interface LaunchPreviewOptions {
  signal?: AbortSignal;
  warn?: (message: string) => void;
}

function probe(command: string, args: string[], signal: AbortSignal | undefined): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal?.removeEventListener('abort', abort);
      // execFile's signal path can use SIGTERM even with a different timeout
      // killSignal. These owned probes must not outlive cancellation if ignored.
      try {
        child.kill('SIGKILL');
        reject(signal?.reason);
      } catch (error) {
        reject(error);
      }
    };
    const child = execFile(
      command,
      args,
      {
        encoding: 'utf8',
        timeout: BROWSER_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => {
        signal?.removeEventListener('abort', abort);
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      },
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
}

/** Build the argv that turns a Chromium executable into a chromeless app window. */
export function buildChromeAppArgs(url: string): string[] {
  return [`--app=${url}`];
}

/* -------------------------------------------------------------------------- */
/* macOS: LaunchServices bundle id -> executable                              */
/* -------------------------------------------------------------------------- */

/**
 * Known Chromium browser bundle ids (lowercased, as LaunchServices stores
 * them) mapped to their default executable path inside /Applications.
 */
const MAC_CHROMIUM_EXES: Readonly<Record<string, string>> = {
  'com.google.chrome': '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  'com.google.chrome.beta': '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  'com.google.chrome.dev': '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  'com.google.chrome.canary': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  'com.microsoft.edgemac': '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'org.chromium.chromium': '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'com.brave.browser': '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  'com.vivaldi.vivaldi': '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
};

/**
 * Map a macOS default-browser bundle id to a candidate Chromium executable
 * path, or `null` if the bundle id is not a Chromium browser we recognise.
 * Pure (does not check the filesystem); callers verify existence.
 */
export function macChromiumExeForBundleId(bundleId: string): string | null {
  return MAC_CHROMIUM_EXES[bundleId.trim().toLowerCase()] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Windows: UserChoice ProgId -> executable                                   */
/* -------------------------------------------------------------------------- */

/** Known Chromium http-handler ProgId prefixes (case-insensitive). */
const WINDOWS_CHROMIUM_PROGID_PREFIXES: readonly string[] = [
  'ChromeHTML', // Google Chrome
  'MSEdgeHTM', // Microsoft Edge
  'MSEdgeMHT', // Microsoft Edge (alt)
  'BraveHTML', // Brave
  'ChromiumHTM', // Chromium
  'VivaldiHTM', // Vivaldi
  'OperaStable', // Opera
];

/** True if a Windows UserChoice ProgId belongs to a known Chromium browser. */
export function isWindowsChromiumProgId(progId: string): boolean {
  const p = progId.trim().toLowerCase();
  return WINDOWS_CHROMIUM_PROGID_PREFIXES.some(prefix => p.startsWith(prefix.toLowerCase()));
}

/**
 * Extract the browser executable path from a Windows `shell\open\command`
 * registry value, e.g.
 *   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --single-argument %1
 * Returns the unquoted path to the `.exe`, or `null` if none can be parsed.
 * Pure.
 */
export function parseWindowsCommandExe(command: string): string | null {
  const trimmed = command.trim();
  // Quoted path: take everything inside the first pair of double quotes.
  const quoted = /^"([^"]+\.exe)"/i.exec(trimmed);
  if (quoted) {
    return quoted[1] ?? null;
  }
  // Unquoted: take up to the first `.exe` token.
  const unquoted = /^(\S+\.exe)/i.exec(trimmed);
  return unquoted?.[1] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Linux: xdg default .desktop -> executable basename                         */
/* -------------------------------------------------------------------------- */

/** Known Chromium `.desktop` file stems mapped to executable basenames. */
const LINUX_CHROMIUM_BINARIES: Readonly<Record<string, string>> = {
  'google-chrome': 'google-chrome',
  'google-chrome-stable': 'google-chrome-stable',
  'google-chrome-beta': 'google-chrome-beta',
  'google-chrome-unstable': 'google-chrome-unstable',
  chromium: 'chromium',
  'chromium-browser': 'chromium-browser',
  'microsoft-edge': 'microsoft-edge',
  'microsoft-edge-stable': 'microsoft-edge-stable',
  'microsoft-edge-beta': 'microsoft-edge-beta',
  'microsoft-edge-dev': 'microsoft-edge-dev',
  'brave-browser': 'brave-browser',
  'brave-browser-stable': 'brave-browser-stable',
  'vivaldi-stable': 'vivaldi-stable',
};

/**
 * Map a Linux default-browser `.desktop` name (with or without the
 * `.desktop` suffix) to a Chromium executable basename to look up on `PATH`,
 * or `null` if it is not a recognised Chromium browser. Pure.
 */
export function linuxChromiumBinaryForDesktop(desktop: string): string | null {
  const stem = desktop
    .trim()
    .toLowerCase()
    .replace(/\.desktop$/, '');
  return LINUX_CHROMIUM_BINARIES[stem] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Impure detection (one per platform)                                        */
/* -------------------------------------------------------------------------- */

/** Resolve the default-browser Chromium executable on macOS, or null. */
async function detectMacChromiumExe(signal: AbortSignal | undefined): Promise<string | null> {
  const plist = `${homedir()}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`;
  const stdout = await probe('plutil', ['-convert', 'json', '-o', '-', plist], signal);
  const parsed = JSON.parse(stdout) as { LSHandlers?: Array<Record<string, unknown>> };
  const handlers = parsed.LSHandlers ?? [];
  const http = handlers.find(h => h['LSHandlerURLScheme'] === 'http');
  const bundleId = typeof http?.['LSHandlerRoleAll'] === 'string' ? http['LSHandlerRoleAll'] : '';
  if (!bundleId) {
    return null;
  }
  const exe = macChromiumExeForBundleId(bundleId);
  return exe && existsSync(exe) ? exe : null;
}

/** Resolve the default-browser Chromium executable on Windows, or null. */
async function detectWindowsChromiumExe(signal: AbortSignal | undefined): Promise<string | null> {
  const userChoice = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice';
  const progIdOut = await probe('reg', ['query', userChoice, '/v', 'ProgId'], signal);
  const progIdMatch = /ProgId\s+REG_SZ\s+(\S+)/i.exec(progIdOut);
  const progId = progIdMatch?.[1];
  if (!progId || !isWindowsChromiumProgId(progId)) {
    return null;
  }
  const cmdOut = await probe('reg', ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'], signal);
  const cmdMatch = /REG_SZ\s+(.+)/i.exec(cmdOut);
  if (!cmdMatch) {
    return null;
  }
  const command = cmdMatch[1];
  if (!command) {
    return null;
  }
  const exe = parseWindowsCommandExe(command);
  return exe && existsSync(exe) ? exe : null;
}

/** Resolve the default-browser Chromium executable on Linux, or null. */
async function detectLinuxChromiumExe(signal: AbortSignal | undefined): Promise<string | null> {
  const stdout = await probe('xdg-settings', ['get', 'default-web-browser'], signal);
  const binary = linuxChromiumBinaryForDesktop(stdout);
  if (!binary) {
    return null;
  }
  // Resolve to an absolute path on PATH; `which` exits non-zero if missing.
  const whichOut = await probe('which', [binary], signal);
  const resolved = whichOut.trim();
  return resolved ? resolved : null;
}

/**
 * Detect the Chromium executable backing the OS default browser, or null if
 * the default browser is not Chromium / cannot be located.
 */
async function detectDefaultChromiumExe(signal: AbortSignal | undefined): Promise<string | null> {
  switch (process.platform) {
    case 'darwin':
      return detectMacChromiumExe(signal);
    case 'win32':
      return detectWindowsChromiumExe(signal);
    case 'linux':
      return detectLinuxChromiumExe(signal);
    default:
      return null;
  }
}

function handOffBrowser(
  command: string,
  args: string[],
  signal: AbortSignal | undefined,
  onExitFailure: (error: Error) => void,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code: number | null) => {
      if (code !== null && code !== 0) {
        onExitFailure(new Error(`${command} exited with status ${code}`));
      }
    });
    child.once('spawn', () => {
      // Ownership ends at handoff. Never kill a browser (or its OS launcher)
      // during shutdown; only our short-lived detection processes are aborted.
      child.unref();
      resolve();
    });
  });
}

function openDefaultBrowser(
  url: string,
  signal: AbortSignal | undefined,
  onExitFailure: (error: Error) => void,
): Promise<void> {
  switch (process.platform) {
    case 'darwin':
      return handOffBrowser('open', [url], signal, onExitFailure);
    case 'win32': {
      const command = `Start-Process '${url.replace(/'/g, "''")}'`;
      return handOffBrowser(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        signal,
        onExitFailure,
      );
    }
    default:
      return handOffBrowser('xdg-open', [url], signal, onExitFailure);
  }
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Open `url` for the user. Prefers a chromeless `--app` window when the
 * default browser is Chromium; otherwise hands off to the OS URL launcher.
 * Detection helpers are bounded and cancellable; the user's browser is not.
 * Best-effort failures are logged, never propagated into model execution.
 */
export async function launchPreview(url: string, options: LaunchPreviewOptions = {}): Promise<void> {
  // Skip entirely for tests / headless CI.
  const { signal } = options;
  if (process.env.MANIFOLD_MCP_NO_OPEN || signal?.aborted) {
    return;
  }

  const warn = options.warn ?? (message => process.stderr.write(`[manifold3d-mcp] ${message}\n`));
  const reportFailure = (stage: string, error: unknown): void => {
    if (!signal?.aborted) {
      warn(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let exe: string | null = null;
  try {
    exe = await detectDefaultChromiumExe(signal);
  } catch (error) {
    reportFailure('default browser detection failed', error);
  }
  if (signal?.aborted) {
    return;
  }
  if (exe) {
    try {
      await handOffBrowser(exe, buildChromeAppArgs(url), signal, error =>
        reportFailure('app-window launch failed', error),
      );
      return;
    } catch (error) {
      reportFailure('app-window launch failed', error);
    }
  }

  if (!signal?.aborted) {
    try {
      await openDefaultBrowser(url, signal, error => reportFailure('browser launch failed', error));
    } catch (error) {
      reportFailure('browser launch failed', error);
    }
  }
}
