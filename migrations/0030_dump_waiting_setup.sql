-- A dump refused by the setup gate (no locked Brand Profile or no approved Research Brief) is kept
-- as "waiting for setup" instead of failing: her files stay saved, and the moment the gate opens
-- (profile locked / brief approved) it is sent through the same path as the Dump button, once.
-- Additive only: NULL = not waiting.
ALTER TABLE dumps ADD COLUMN waiting_setup_at TEXT;
