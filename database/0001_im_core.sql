BEGIN;

CREATE TABLE conversation (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('direct', 'group')),
    direct_key text,
    title text,
    avatar_url text,
    created_by_type text NOT NULL CHECK (created_by_type IN ('member', 'agent')),
    created_by_id uuid NOT NULL,
    next_message_seq bigint NOT NULL DEFAULT 1 CHECK (next_message_seq > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    archived_at timestamptz,
    CONSTRAINT conversation_direct_key_shape CHECK (
        (kind = 'direct' AND direct_key IS NOT NULL)
        OR (kind = 'group' AND direct_key IS NULL)
    ),
    UNIQUE (id, workspace_id)
);

CREATE UNIQUE INDEX conversation_workspace_direct_key_uq
    ON conversation (workspace_id, direct_key)
    WHERE kind = 'direct';

CREATE INDEX conversation_workspace_updated_idx
    ON conversation (workspace_id, updated_at DESC, id);

CREATE TABLE conversation_participant (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    subject_type text NOT NULL CHECK (subject_type IN ('member', 'agent')),
    subject_id uuid NOT NULL,
    role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
    state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'left', 'removed')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    left_at timestamptz,
    last_read_seq bigint NOT NULL DEFAULT 0 CHECK (last_read_seq >= 0),
    last_read_at timestamptz,
    CONSTRAINT conversation_participant_state_time CHECK (
        (state = 'active' AND left_at IS NULL)
        OR (state <> 'active' AND left_at IS NOT NULL)
    ),
    CONSTRAINT conversation_participant_conversation_fk
        FOREIGN KEY (conversation_id, workspace_id)
        REFERENCES conversation (id, workspace_id),
    UNIQUE (conversation_id, subject_type, subject_id),
    UNIQUE (id, conversation_id)
);

CREATE INDEX conversation_participant_subject_active_idx
    ON conversation_participant (workspace_id, subject_type, subject_id, conversation_id)
    WHERE state = 'active';

CREATE TABLE message (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    seq bigint NOT NULL CHECK (seq > 0),
    sender_participant_id uuid,
    kind text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'system')),
    content_type text NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'markdown', 'json')),
    body_text text,
    body_json jsonb,
    reply_to_message_id uuid,
    client_message_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    CONSTRAINT message_sender_shape CHECK (
        (kind = 'user' AND sender_participant_id IS NOT NULL)
        OR (kind = 'system' AND sender_participant_id IS NULL)
    ),
    CONSTRAINT message_body_shape CHECK (
        (deleted_at IS NOT NULL)
        OR (content_type IN ('text', 'markdown') AND body_text IS NOT NULL AND body_json IS NULL)
        OR (content_type = 'json' AND body_json IS NOT NULL AND body_text IS NULL)
    ),
    CONSTRAINT message_conversation_fk
        FOREIGN KEY (conversation_id, workspace_id)
        REFERENCES conversation (id, workspace_id),
    CONSTRAINT message_sender_fk
        FOREIGN KEY (sender_participant_id, conversation_id)
        REFERENCES conversation_participant (id, conversation_id),
    UNIQUE (conversation_id, seq),
    UNIQUE (id, conversation_id),
    UNIQUE (id, workspace_id)
);

ALTER TABLE message
    ADD CONSTRAINT message_reply_fk
    FOREIGN KEY (reply_to_message_id, conversation_id)
    REFERENCES message (id, conversation_id);

CREATE UNIQUE INDEX message_sender_client_id_uq
    ON message (sender_participant_id, client_message_id)
    WHERE sender_participant_id IS NOT NULL AND client_message_id IS NOT NULL;

CREATE INDEX message_conversation_history_idx
    ON message (conversation_id, seq DESC);

CREATE TABLE message_attachment (
    id uuid PRIMARY KEY,
    message_id uuid NOT NULL REFERENCES message (id) ON DELETE CASCADE,
    storage_key text NOT NULL UNIQUE,
    file_name text NOT NULL,
    mime_type text NOT NULL,
    byte_size bigint NOT NULL CHECK (byte_size >= 0),
    sha256 text,
    width integer CHECK (width IS NULL OR width > 0),
    height integer CHECK (height IS NULL OR height > 0),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_attachment_message_idx
    ON message_attachment (message_id, created_at, id);

CREATE TABLE message_reaction (
    message_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    emoji text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT message_reaction_message_fk
        FOREIGN KEY (message_id, conversation_id)
        REFERENCES message (id, conversation_id) ON DELETE CASCADE,
    CONSTRAINT message_reaction_participant_fk
        FOREIGN KEY (participant_id, conversation_id)
        REFERENCES conversation_participant (id, conversation_id),
    PRIMARY KEY (message_id, participant_id, emoji)
);

CREATE INDEX message_reaction_participant_idx
    ON message_reaction (participant_id, created_at DESC);

CREATE TABLE agent_message_delivery (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL,
    message_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    target text NOT NULL,
    seq bigint GENERATED ALWAYS AS IDENTITY CHECK (seq > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_sent_at timestamptz,
    acked_at timestamptz,
    CONSTRAINT agent_message_delivery_message_fk
        FOREIGN KEY (message_id, workspace_id)
        REFERENCES message (id, workspace_id),
    UNIQUE (workspace_id, agent_id, seq),
    UNIQUE (message_id, agent_id, target)
);

CREATE INDEX agent_message_delivery_pending_idx
    ON agent_message_delivery (workspace_id, agent_id, seq)
    WHERE acked_at IS NULL;

CREATE INDEX agent_message_delivery_message_idx
    ON agent_message_delivery (message_id, agent_id);

COMMIT;
