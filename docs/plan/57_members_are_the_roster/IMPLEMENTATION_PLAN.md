# Plan 57: The roster is the members

## Goal

The time clock's roster is the patrol's members, not a second list. Today they're two:

- **Members** (users:*) lists people with permissions or a plain invite. It needs an email, sends sign-in invites, and shows "patroller" as a badge it can't change.
- **Time Tracking → Roster** (time_tracking:manage) is its own CRUD over `PatrollerProfile`: name, NSP ID, patrol level, active, optional contact, with its own CSV import.

After this plan there's one list. Everyone who is a member can clock in, and everything about a person is edited on Members. People without an NSP ID choose a 6-digit PIN to clock in with.

## Decisions

| # | Decision |
|---|---|
| D1 | **Every member is on the clock.** The iPad's roster is the org's members: live, and not switched to inactive (D5). Nobody is marked "patroller" separately. Someone who is only a ski swap seller isn't a member and isn't on it. |
| D2 | **Being a member is a member record, and selling doesn't change it.** Today "member" is guessed from other rows (no seller profile, or some permission, or a roster entry), so a member who later sells at the swap can drop off Members. Every member now gets a member record: the existing `PatrollerProfile` row, kept under that name to avoid touching the clock's events. A membership with one is a member, whatever else it has. It's created when someone is added, invited, imported or given permissions, and backfilled for existing members. |
| D3 | **Members is the only place people are edited.** NSP ID, patrol level, inactive, name, email and phone move onto Members (list columns, the edit form, the import). Time Tracking's Roster tab and its create/edit/delete/import routes go away. The roster read the iPad uses stays. |
| D4 | **Contact is optional.** A member can be added with a name and at least one of email, phone or NSP ID: something to tell two people apart by. No email means no invite and no web sign-in until one is added, and they can still clock in with an NSP ID. |
| D5 | **Inactive stays, on Members.** An "Inactive" switch keeps someone a member, with their permissions and history, but off the iPad's clock-in list. Making someone inactive, or removing them, closes an open shift with an admin clock-out, as the roster does today. |
| D6 | **Members managers edit it all** (`users:manage`). Setting permissions still needs `permissions:assign`. `time_tracking:manage` keeps shifts and terminals, not people. |
| D7 | **A member without an NSP ID chooses a 6-digit PIN** to clock in with, on a new My account page after signing in. One verifier per person: with an NSP ID, the NSP ID; otherwise the PIN. Setting an NSP ID clears the PIN. |
| D8 | **A PIN is unique within the org,** and never equal to any member's NSP ID there. Clocking out finds the person by the code typed, so two people can't share one. If a member is later given an NSP ID that equals someone's PIN, that PIN is cleared and My account asks for a new one. |
| D9 | **Staff never see a PIN.** Members shows "PIN set" or "No NSP ID or PIN: can't clock in", and a members manager can clear a PIN, for example when someone forgets theirs. The iPad gets it, as it gets NSP IDs, because it verifies offline. |
| D10 | **One import.** The Members import takes NSP ID, patrol level and inactive columns, maps columns the way the roster import does (whatever the patrol's NSP export calls them), and offers preserve or overwrite. The roster import goes away. |

## Server

### Schema (migration `…_members_are_the_roster`)

- `PatrollerProfile.clockPin String? @db.VarChar(6)` (D7). Additive.
- **Backfill, in the migration:** a `PatrollerProfile` for every live membership that is a member by today's rule (no live seller profile, or any permission) and has none. This inserts rows into production, so it needs the user's yes at deploy.

### Who is a member (`common/identity/membership-kinds.ts`)

- `IS_MEMBER` becomes: a live member record (D2), or any permission. The "no seller profile" clause goes, because the backfill gives those people a record.
- `MemberRecordService.ensure(membershipId)` creates the record. Called from `inviteMember`, `bulkImport`, permission grants, and anywhere else a membership becomes a member: org creation's owner, the bootstrap admin, and staff check-in sign-ins, found by grep. The device roster read also calls it for any member found without one, so a path missed here mends itself.

### Members (`members.service.ts`, `members.contracts.ts`)

- **`MemberResponse` gains:**
  - `nspId`, `patrolLevel`, `inactive`;
  - `clockPinSet`;
  - `canClockIn`: live, active, and an NSP ID or a PIN.
- **`InviteMemberSchema`:**
  - `email` becomes optional;
  - adds `nspId`, `patrolLevel`;
  - refused without a first and last name and at least one of email, phone or NSP ID (D4);
  - the invite email goes only when there's an email.
- **`UpdateMemberSchema` gains** `firstName`, `lastName`, `email`, `phone`, `nspId`, `patrolLevel`, `inactive` and `clearClockPin`, all `users:manage` (D6):
  - contact changes keep today's rules: changing a proven contact unverifies it (`unverifyChangedContacts`);
  - NSP IDs stay globally unique (`assertNspAvailable`);
  - setting an NSP ID clears the PIN (D7);
  - an NSP ID equal to another member's PIN clears that PIN (D8);
  - `inactive: true`, or removal, closes an open shift (D5).
- **Bulk import (D10):**
  - `POST members/import/parse` returns the headers, a guessed mapping and a preview, as the roster's parse does;
  - `POST members/import` takes mapped rows and a strategy;
  - each row matches a person by NSP ID, then email, then phone (`PersonService.resolve`), as the roster import does;
  - outcomes keep today's shape, keyed by row, and invites go only with `sendInvites`.
- Every change is audited with before and after, as the roster's are (Plan 55 D11).

### My account (`me.controller.ts`)

- `GET me/clock` returns, for each org where the user is a member: the org's name, whether the org has time tracking, `hasNspId`, and `clockPinSet`.
- `PUT me/orgs/:orgId/clock-pin { pin }`:
  - six digits;
  - refused when they have an NSP ID (D7);
  - refused when the PIN is taken, as a PIN or an NSP ID, without saying by whom (D8);
  - audited, without the PIN;
  - bumps the membership's watermark, so the iPads pick it up.

### Time clock (`patroller.service.ts`, `patroller.controller.ts`)

- **`GET time-clock/patrollers`** (device and `time_tracking:report`) reads members:
  - live, `IS_MEMBER`, in the org;
  - `active` from inactive (D5).
- **The terminal's shape** gains `clockPin` (D9). Staff's shape never carries it.
- **A member with neither code** is still listed with `active: true`, so the board can name them. The iPad can't verify them, and its handoff says so.
- **Removed:** `POST`, `PATCH`, `DELETE`, `import`, `import/parse`, `import/template` and `sendOnboarding`. Their logic moves to members.
- **Health (Plan 55 D13) gains** "members who can't clock in": live and active, with no NSP ID or PIN. It's a count, linking to the Members filter.

## Web

- **Members page:**
  - columns for NSP ID and patrol level, and badges for "Inactive" and "Can't clock in";
  - a filter for "Can't clock in" and one for "Inactive";
  - **Add member:** name, then email, phone, NSP ID and patrol level, at least one of the three identifiers, and permissions;
  - **Edit member:** the same fields, plus inactive and, when a PIN is set, "Clear PIN";
  - a confirmation before making someone inactive or removing them while they're on shift: "Jane Doe is on shift at North Lodge. This clocks her out."
  - **Import:** upload, column mapping, preview, preserve/overwrite and "send invites", following the roster import modal, which moves here.
- **My account** (new, from the name at the foot of the sidebar):
  - each org's clock-in identity: "Your NSP ID is 100001" (set by your patrol), or "Choose a 6-digit PIN to clock in with";
  - set or change the PIN.
- **Time Tracking:**
  - the Roster tab goes;
  - On Shift's empty state says who can clock in: "Every member of Demo Org can clock in. Manage people under Members."

## The iPad (handoff)

- **The roster carries `clockPin`.** Clock-in verifies the typed code against the chosen person's NSP ID if they have one, otherwise their PIN. Clock-out finds the person whose NSP ID or PIN equals the code.
- **Copy:** "NSP ID" becomes "NSP ID or PIN" on the keypad screens.
- **Members with neither code** show in name search as "Can't clock in yet: ask a patrol leader", rather than vanishing.
- **Old builds** keep working for everyone with an NSP ID. Members who only have a PIN can't clock in on them, and no iPad is in production yet.

## Tests

- **Pure:**
  - the PIN rules: six digits, unique against PINs and NSP IDs, cleared by an NSP ID;
  - the import's column mapping.
- **Service:**
  - a member added with only a name and an NSP ID is on the roster;
  - one who then sells at the swap is still a member (D2);
  - inactive leaves the roster and closes a shift;
  - a seller-only person is never on it.
- **Smoke `smoke-members-clock.mjs`:**
  - add members by form and by import (contactless, NSP-only, email-only);
  - a terminal's roster lists them, with PINs and without contacts;
  - set a PIN through `me`, and see it refused when taken or when the member has an NSP ID;
  - clock in by NSP ID and by PIN;
  - make a member inactive while on shift, and the shift closes;
  - the old roster routes are 404s.
- **Updated:** `smoke-time-clock.mjs` and `smoke-time-clock-concurrency.mjs` create their patrollers through Members.

## Rollout

1. Production census (read-only): members per org, how many would be backfilled, and NSP IDs set.
2. **Ask before deploying:** an additive column, plus the backfill inserting member records for existing members.
3. Deploy, then run the smokes on the server (as `patrolkit`, through `systemd-run` with the app's environment), then push as usual.

## Not in this plan

- Staff choosing or seeing PINs.
- A PIN for members who have an NSP ID.
- Separate contact details per org.
- The iPad build itself (handoff only).

## Where the build drifted

- **The migration is `20261101120000_members_are_the_roster`.** Plan 56 (Tablets) landed `20261031120000_tablets` with the same timestamp while this was being built, so this one moved a day later to sort after it.
- **A name is required only without an email.** An email-only invite still works as it did; a member with no email needs a first and last name, because that's how the iPad finds them.
- **Being given permissions, added, imported or restored creates the member record.** The roster read also mends any member found without one, so a path that forgets can't leave someone off the clock.
- **The roster read uses Plan 56's shared tablet roles** (`TIME_CLOCK_TABLET_ROLES`), so an `org.tablet` reads it as a time-clock terminal does.
- **`sendOnboarding` was dead code** (no route called it) and is gone with its spec. Members' "Send invite" replaces it.
- **`smoke-swap-status.mjs`'s "plainly invited member" fixture** now gives the membership a member record, as an invite does. The migration does the same for existing members.
- **The web's `request` helper sends form data without a JSON content type**, so the import's parse step uploads through it like any other call.
