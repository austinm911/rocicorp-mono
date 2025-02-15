DROP TABLE IF EXISTS "user",
    "issue",
    "comment",
    "label",
    "issueLabel",
    "emoji",
    "userPref",
    "zero.schemaVersions" CASCADE;

-- user

CREATE TABLE "user" (
    "id" VARCHAR PRIMARY KEY,
    "login" VARCHAR NOT NULL,
    "name" VARCHAR,
    "avatar" VARCHAR,
    "role" VARCHAR DEFAULT 'user' NOT NULL,
    "githubID" INTEGER NOT NULL
);

CREATE UNIQUE INDEX user_login_idx ON "user" (login);
CREATE UNIQUE INDEX user_githubid_idx ON "user" ("githubID");

-- issue

CREATE TABLE issue (
    "id" VARCHAR PRIMARY KEY,
    "shortID" INTEGER GENERATED BY DEFAULT AS IDENTITY (START WITH 3000),
    "title" VARCHAR(128) NOT NULL,
    "open" BOOLEAN NOT NULL,
    "modified" double precision DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000),
    "created" double precision DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000),
    "creatorID" VARCHAR REFERENCES "user"(id) NOT NULL,
    "assigneeID" VARCHAR REFERENCES "user"(id),
    -- Size chosen because max we currently have in legacy data is ~9KB.
    "description" VARCHAR(10240) DEFAULT '',
    "visibility" VARCHAR DEFAULT 'public' NOT NULL
);


-- viewState

CREATE TABLE "viewState" (
    "userID" VARCHAR REFERENCES "user"(id) ON DELETE CASCADE,
    "issueID" VARCHAR REFERENCES issue(id) ON DELETE CASCADE,
    "viewed" double precision,
    PRIMARY KEY ("userID", "issueID")
);

-- comment

CREATE TABLE comment (
    id VARCHAR PRIMARY KEY,
    "issueID" VARCHAR REFERENCES issue(id) ON DELETE CASCADE,
    "created" double precision,
    "body" TEXT NOT NULL,
    "creatorID" VARCHAR REFERENCES "user"(id)
);



-- label

CREATE TABLE label (
    "id" VARCHAR PRIMARY KEY,
    "name" VARCHAR NOT NULL
);

-- issueLabel

CREATE TABLE "issueLabel" (
    "labelID" VARCHAR REFERENCES label(id),
    "issueID" VARCHAR REFERENCES issue(id) ON DELETE CASCADE,
    PRIMARY KEY ("labelID", "issueID")
);

-- emoji

CREATE TABLE emoji (
    "id" VARCHAR PRIMARY KEY,
    "value" VARCHAR NOT NULL,
    "annotation" VARCHAR,
    -- The PK of the "subject" (either issue or comment) that the emoji is attached to
    -- We cannot use a FK to enforce referential integrity. Instead we use a trigger to enforce this.
    -- We wil also need a custom secondary index on this since the FK won't give it to us.
    "subjectID" VARCHAR NOT NULL,
    "creatorID" VARCHAR REFERENCES "user"(id) ON DELETE CASCADE,
    "created" double precision DEFAULT (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000),

    UNIQUE ("subjectID", "creatorID", "value")
);
CREATE INDEX emoji_created_idx ON emoji (created);
CREATE INDEX emoji_subject_id_idx ON emoji ("subjectID");


-- userPref

CREATE TABLE "userPref" (
    "key" VARCHAR NOT NULL,
    "value" VARCHAR NOT NULL,
    "userID" VARCHAR REFERENCES "user"(id) ON DELETE CASCADE,

    PRIMARY KEY ("userID", "key")
);

-- zero.schemaVersions

CREATE SCHEMA IF NOT EXISTS zero;

CREATE TABLE IF NOT EXISTS zero."schemaVersions" (
    "minSupportedVersion" INT4,
    "maxSupportedVersion" INT4,

    -- Ensure that there is only a single row in the table.
    -- Application code can be agnostic to this column, and
    -- simply invoke UPDATE statements on the version columns.
    "lock" BOOL PRIMARY KEY DEFAULT true,
    CONSTRAINT zero_schema_versions_single_row_constraint CHECK (lock)
);

INSERT INTO zero."schemaVersions" ("lock", "minSupportedVersion", "maxSupportedVersion")
VALUES (true, 3, 5) ON CONFLICT DO NOTHING;

