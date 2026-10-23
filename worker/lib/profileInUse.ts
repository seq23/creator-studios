// Which Brand Profile version every AI step and the setup gate read: the locked one, or, while she
// has it unlocked to edit, the version she locked most recently (locked_at is kept as history on
// unlock). Locking again switches to the new version. Unlocking never stops her clips.
// Guard: tests/unit/profile-in-use.test.ts (also fails on any Worker read of the profile by the locked flag alone).
export const PROFILE_IN_USE = "WHERE (locked = 1 OR locked_at IS NOT NULL) ORDER BY locked DESC, locked_at DESC, version DESC LIMIT 1";
