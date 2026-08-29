-- What the CLI on the other end can do, as a JSON array it declares when it
-- registers. The page needs this to know whether to arm the arrow pad: an older
-- mosh hands anything it is given to readline, so a keypress sent to one would
-- be typed at the prompt of a live machine as text.
--
-- Declared rather than inferred from `version`, so shipping the next capability
-- costs a string here instead of a release number the app has to know about.
ALTER TABLE cli_sessions ADD COLUMN features TEXT;
