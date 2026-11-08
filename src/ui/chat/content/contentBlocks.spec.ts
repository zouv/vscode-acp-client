import { describe, expect, it } from 'vitest';
import { fileLinkTarget, localPathOf } from './contentBlocks';

describe('localPathOf rejects remote filesystem spellings', () => {
  it('keeps normal absolute and relative paths', () => {
    expect(localPathOf('C:\\work\\a.ts')).toBe('C:\\work\\a.ts');
    expect(localPathOf('/home/me/a.ts')).toBe('/home/me/a.ts');
    expect(localPathOf('src/a.ts')).toBe('src/a.ts');
    expect(localPathOf('file:///C:/work/a.ts')).toBeTruthy();
    // A POSIX-style file: URL is platform-specific: Node's fileURLToPath rejects
    // it on Windows (`File URL path must be absolute`). Not the subject here.
  });

  it('rejects UNC shares (backslash and forward-slash spellings)', () => {
    expect(localPathOf('\\\\attacker\\share\\payload')).toBeUndefined();
    expect(localPathOf('//attacker/share/payload')).toBeUndefined();
    expect(localPathOf('\\\\?\\UNC\\attacker\\share\\x')).toBeUndefined();
  });

  it('rejects file: URIs that carry a host/authority', () => {
    expect(localPathOf('file://attacker/share/x')).toBeUndefined();
    // `localhost` is normalised by WHATWG URL to an empty host (loopback, not a
    // remote share), so it is treated as a local file — that is not the SMB risk.
    expect(localPathOf('file://localhost/C:/x')).toBeTruthy();
    expect(localPathOf('file://user@host/x')).toBeUndefined();
  });

  it('a marked link to a UNC share is not treated as a file target', () => {
    expect(fileLinkTarget('\\\\attacker\\share\\x#L12')).toBeUndefined();
    expect(fileLinkTarget('file://attacker/share/x#L12')).toBeUndefined();
  });
});
