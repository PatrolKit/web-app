/**
 * The stations a bridge prints for, as the responses that name them want them
 * (Plan 27).
 *
 * A bridge used to serve one station, and every response carried that one
 * name. It keeps doing so — `stationName` is every live station's name, joined,
 * so an older client reading one string still reads something true — and gains
 * `stationNames` beside it. Retired stations are left out, and the names are
 * sorted so the joined string does not change from one request to the next.
 */
export const BRIDGED_STATIONS_SELECT = {
  where: { deletedAt: null },
  select: { id: true, name: true, code: true, attendantDeviceId: true },
  orderBy: { name: 'asc' },
} as const;

export interface BridgedStation {
  id?: string;
  name: string;
  code?: string;
  attendantDeviceId?: string | null;
  deletedAt?: Date | null;
}

export function bridgedStationNames(stations: BridgedStation[] | null | undefined): {
  stationName: string | null;
  stationNames: string[];
} {
  const names = (stations ?? [])
    .filter((s) => !s.deletedAt)
    .map((s) => s.name)
    .sort((a, b) => a.localeCompare(b));
  return { stationName: names.length ? names.join(', ') : null, stationNames: names };
}
