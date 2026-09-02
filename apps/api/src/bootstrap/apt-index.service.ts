import { Injectable, Logger } from '@nestjs/common';
import { gunzipSync } from 'zlib';
import { newestVersion } from './debian-version';

/** What a repository stanza needs to be located. */
export interface RepositoryCoordinates {
  uri: string;
  suite: string;
  components: string[];
  arch: string;
}

interface CacheEntry {
  at: number;
  /** Package name → the newest version the index carries. */
  versions: Map<string, string>;
}

/**
 * Reads `Packages` indexes so a profile can track the newest build of a package
 * rather than naming a version by hand.
 *
 * This makes the apt repository a dependency of device check-in, which it was
 * not when every version was pinned. Two things bound that: a five-minute
 * memory cache (index responses carry `max-age=60`, so asking more often buys
 * nothing), and the caller's durable fallback — `BootstrapPackage.resolvedVersion`
 * — for when this returns nothing at all. A repository having a bad five minutes
 * must not stop a fleet checking in.
 *
 * Signatures are deliberately not verified here. This index decides which
 * version number to *name*; the device verifies the package it actually
 * installs against a key baked into its image, and a lie told here can pin a
 * device to a different PatrolKit-signed version and nothing more.
 */
@Injectable()
export class AptIndexService {
  private readonly log = new Logger(AptIndexService.name);
  private readonly cache = new Map<string, CacheEntry>();

  /** Long enough that steady-state check-ins never touch the network. */
  private readonly ttlMs = 5 * 60_000;
  private readonly timeoutMs = 10_000;

  /**
   * The newest version of `packageName` across every component of every given
   * repository, or null if no index carries it.
   *
   * Null covers both "the repository is unreachable" and "the package is not
   * published there". The caller cannot act differently on the two — either way
   * it has no version to serve and must fall back — and pretending to
   * distinguish them would mean trusting a 404 from a CDN.
   */
  async newestVersionOf(
    packageName: string,
    repositories: readonly RepositoryCoordinates[],
  ): Promise<string | null> {
    const found: string[] = [];

    for (const repo of repositories) {
      for (const component of repo.components) {
        const versions = await this.index(repo, component);
        const version = versions?.get(packageName);
        if (version) found.push(version);
      }
    }

    return newestVersion(found);
  }

  /** Drops the memory cache. The admin preview uses this to force a real read. */
  invalidate(): void {
    this.cache.clear();
  }

  private async index(
    repo: RepositoryCoordinates,
    component: string,
  ): Promise<Map<string, string> | null> {
    const key = `${repo.uri}|${repo.suite}|${component}|${repo.arch}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.versions;

    const base = `${repo.uri.replace(/\/+$/, '')}/dists/${encodeURIComponent(repo.suite)}/${encodeURIComponent(component)}/binary-${encodeURIComponent(repo.arch)}`;

    // Compressed first, because that is what a repository always publishes and
    // what the device itself fetches. The plain file is a courtesy to a
    // hand-rolled mirror that omits the gzip.
    for (const [url, gzipped] of [
      [`${base}/Packages.gz`, true],
      [`${base}/Packages`, false],
    ] as const) {
      const body = await this.fetchIndex(url, gzipped);
      if (body === null) continue;
      const versions = parsePackagesIndex(body);
      this.cache.set(key, { at: Date.now(), versions });
      return versions;
    }

    // Cached rather than retried on the next request: a repository that is down
    // stays down for a few minutes, and hammering it once per device check-in
    // turns an outage into a thundering herd. The caller falls back either way.
    this.cache.set(key, { at: Date.now(), versions: new Map() });
    return null;
  }

  private async fetchIndex(url: string, gzipped: boolean): Promise<string | null> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'User-Agent': 'patrolkit-server' },
      });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      return gzipped ? gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
    } catch (err) {
      this.log.warn(`could not read ${url}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

/**
 * Parses a `Packages` file into the newest version of each package.
 *
 * Stanzas are separated by blank lines and continuation lines start with
 * whitespace; only `Package:` and `Version:` are read, and everything else is
 * ignored rather than parsed. A repository may carry several versions of one
 * package — `pool/` is append-only precisely so it can — so the newest wins
 * rather than the last seen.
 */
export function parsePackagesIndex(text: string): Map<string, string> {
  const versions = new Map<string, string>();
  let name: string | null = null;
  let version: string | null = null;

  const flush = () => {
    if (name && version) {
      const existing = versions.get(name);
      if (!existing || newestVersion([existing, version]) === version) {
        versions.set(name, version);
      }
    }
    name = null;
    version = null;
  };

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (/^\s/.test(line)) continue; // a continuation of the previous field
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'package') name = value;
    else if (field === 'version') version = value;
  }
  flush();

  return versions;
}
