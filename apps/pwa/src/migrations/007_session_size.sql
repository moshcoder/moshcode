-- Terminal geometry of the machine being mirrored. The web mirror is a real
-- terminal emulator, so it has to run at the same size as the tty on the other
-- end: a page 80 columns wide replaying 120-column output wraps every line in
-- the wrong place, and anything that redraws in place (spinners, progress,
-- boxes) lands as garbage.
ALTER TABLE cli_sessions ADD COLUMN cols INTEGER;
ALTER TABLE cli_sessions ADD COLUMN rows INTEGER;
