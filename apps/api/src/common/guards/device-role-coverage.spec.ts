import * as fs from 'fs';
import * as path from 'path';

/**
 * Devices used to pass every permission check unconditionally, so any
 * device-reachable route worked whether or not anyone had thought about it.
 * Now `PermissionsGuard` refuses a device on a route that names no role — which
 * is the safe default, and also means forgetting the annotation silently breaks
 * a device in the field.
 *
 * This walks the controllers and asserts the annotation is present wherever it
 * is load-bearing, so the failure shows up here rather than at a venue.
 */
describe('device role coverage', () => {
  const SRC = path.join(__dirname, '..', '..');

  function controllers(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return controllers(full);
      return e.isFile() && e.name.endsWith('.controller.ts') ? [full] : [];
    });
  }

  /**
   * Comments stripped before anything is matched.
   *
   * Every check below asks whether a controller *uses* a guard, and a bare grep
   * cannot tell that from a comment explaining why it does not — which made
   * writing down the reasoning for a deliberate choice fail the test that the
   * reasoning was about.
   */
  function code(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Not `://`, so a URL in a string survives.
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  const files = controllers(SRC).map((f) => ({
    file: path.relative(SRC, f),
    src: code(fs.readFileSync(f, 'utf8')),
  }));

  it('finds the controllers to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('every device-reachable, permission-guarded route names a device role', () => {
    const missing = files
      .filter((f) => /\bOrDeviceAuthGuard\b|\bDeviceAuthGuard\b/.test(f.src))
      .filter((f) => /\bPermissionsGuard\b/.test(f.src))
      .filter((f) => !/@RequireDeviceRole\(/.test(f.src))
      .map((f) => f.file);

    expect(missing).toEqual([]);
  });

  it('no controller still expects a per-device permission set', () => {
    const stale = files
      .filter((f) => /DevicePermission|device\.permissions/.test(f.src))
      .map((f) => f.file);

    expect(stale).toEqual([]);
  });
});
