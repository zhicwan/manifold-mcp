import { describe, expect, it } from 'vitest';

import {
  buildChromeAppArgs,
  isWindowsChromiumProgId,
  linuxChromiumBinaryForDesktop,
  macChromiumExeForBundleId,
  parseWindowsCommandExe,
} from '../packages/manifold3d-mcp/src/server/preview/launch-browser.js';

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
