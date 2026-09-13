CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'read' CHECK (role IN ('read','writer','admin','owner')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX idx_organization_members_user ON organization_members(user_id);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (id, organization_id),
  UNIQUE (organization_id, name)
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'read' CHECK (role IN ('read','writer','admin','owner')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id, organization_id) REFERENCES teams(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, user_id) REFERENCES organization_members(organization_id, user_id) ON DELETE CASCADE
);
CREATE INDEX idx_team_members_user ON team_members(user_id);

CREATE TABLE session_team_shares (
  session_id TEXT NOT NULL REFERENCES cli_sessions(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  shared_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, team_id)
);
CREATE INDEX idx_session_team_shares_team ON session_team_shares(team_id);

-- Organization administrators manage every team. Other organization members
-- only enter teams they belong to; organization membership alone shares no terminal.
CREATE VIEW team_access AS
  SELECT team_id, user_id, MAX(permission) AS permission FROM (
    SELECT team_id, user_id,
      CASE role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'writer' THEN 2 ELSE 1 END AS permission
    FROM team_members
    UNION ALL
    SELECT t.id, m.user_id, CASE m.role WHEN 'owner' THEN 4 ELSE 3 END
    FROM teams t JOIN organization_members m ON m.organization_id=t.organization_id
    WHERE m.role IN ('owner','admin')
  ) GROUP BY team_id, user_id;

CREATE VIEW shared_session_access AS
  SELECT s.session_id, a.user_id, MAX(a.permission) AS permission
  FROM session_team_shares s JOIN team_access a ON a.team_id=s.team_id
  GROUP BY s.session_id, a.user_id;

-- Kept on queued commands so revoking a member also stops their pending input.
-- No FK: deleting an actor must not turn their command into an owner command.
ALTER TABLE session_commands ADD COLUMN actor_user_id TEXT;
