import fs from 'fs';
import os from 'os';
import path from 'path';

import postgres from 'postgres';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';
import { readEnvFile } from './env.js';

let sql: postgres.Sql;

const _envDb = readEnvFile(['DATABASE_URL', 'NODE_ID', 'SESSION_GROUP']);
const DATABASE_URL =
  process.env.DATABASE_URL ||
  _envDb.DATABASE_URL ||
  'postgresql://nanoclaw:nanoclaw_secret@localhost:5433/nanoclaw';

export const NODE_ID = process.env.NODE_ID || _envDb.NODE_ID || os.hostname();

// SESSION_GROUP groups instances that share conversation history (e.g. mac+synology = "main")
// Defaults to NODE_ID if not set (each instance has its own session)
export const SESSION_GROUP =
  process.env.SESSION_GROUP || _envDb.SESSION_GROUP || NODE_ID;

async function createSchema(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      reply_to_message_id TEXT,
      reply_to_message_content TEXT,
      reply_to_sender_name TEXT,
      node_id TEXT DEFAULT '',
      PRIMARY KEY (id, chat_jid)
    )
  `;

  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS node_id TEXT DEFAULT ''`;

  await sql`CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_node_id ON messages(node_id)`;

  await sql`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      script TEXT
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status)`;

  await sql`
    CREATE TABLE IF NOT EXISTS task_run_logs (
      id BIGSERIAL PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT
    )
  `;

  await sql`CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at)`;

  await sql`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT NOT NULL,
      node_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL,
      last_node TEXT,
      PRIMARY KEY (group_folder, node_id)
    )
  `;

  // Migration: upgrade sessions PK from (group_folder) to (group_folder, node_id)
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name = 'node_id'
      ) THEN
        ALTER TABLE sessions ADD COLUMN node_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE sessions DROP CONSTRAINT sessions_pkey;
        ALTER TABLE sessions ADD PRIMARY KEY (group_folder, node_id);
      END IF;
    END $migration$;
  `;
  await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_node TEXT`;

  await sql`
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT NOT NULL,
      session_group TEXT NOT NULL DEFAULT 'main',
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      PRIMARY KEY (jid, session_group)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      hostname TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      status TEXT DEFAULT 'active'
    )
  `;

  // Migrations: add columns if not exist (PostgreSQL 9.6+)
  await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS channel TEXT`;
  await sql`ALTER TABLE chats ADD COLUMN IF NOT EXISTS is_group INTEGER DEFAULT 0`;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_bot_message INTEGER DEFAULT 0`;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id TEXT`;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_content TEXT`;
  await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_sender_name TEXT`;
  await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS context_mode TEXT DEFAULT 'isolated'`;
  await sql`ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS script TEXT`;
  await sql`ALTER TABLE registered_groups ADD COLUMN IF NOT EXISTS is_main INTEGER DEFAULT 0`;

  // Migration: upgrade registered_groups PK from (jid) to (jid, session_group)
  await sql`
    DO $migration$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'registered_groups' AND column_name = 'session_group'
      ) THEN
        ALTER TABLE registered_groups ADD COLUMN session_group TEXT NOT NULL DEFAULT 'main';
        ALTER TABLE registered_groups DROP CONSTRAINT registered_groups_pkey;
        ALTER TABLE registered_groups DROP CONSTRAINT IF EXISTS registered_groups_folder_key;
        ALTER TABLE registered_groups ADD PRIMARY KEY (jid, session_group);
      END IF;
    END $migration$;
  `;
}

export async function initDatabase(): Promise<void> {
  sql = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {}, // suppress ALTER TABLE IF NOT EXISTS notices
  });
  await createSchema();
  await migrateJsonState();
}

export async function closeDatabase(): Promise<void> {
  await sql.end();
}

/** @internal - for tests only */
export async function _initTestDatabase(): Promise<void> {
  sql = postgres(process.env.TEST_DATABASE_URL || DATABASE_URL);
  await createSchema();
}

/** @internal - for tests only */
export async function _closeDatabase(): Promise<void> {
  await sql.end();
}

export async function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): Promise<void> {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    await sql`
      INSERT INTO chats (jid, name, last_message_time, channel, is_group)
      VALUES (${chatJid}, ${name}, ${timestamp}, ${ch}, ${group})
      ON CONFLICT (jid) DO UPDATE SET
        name = EXCLUDED.name,
        last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
        channel = COALESCE(EXCLUDED.channel, chats.channel),
        is_group = COALESCE(EXCLUDED.is_group, chats.is_group)
    `;
  } else {
    await sql`
      INSERT INTO chats (jid, name, last_message_time, channel, is_group)
      VALUES (${chatJid}, ${chatJid}, ${timestamp}, ${ch}, ${group})
      ON CONFLICT (jid) DO UPDATE SET
        last_message_time = GREATEST(chats.last_message_time, EXCLUDED.last_message_time),
        channel = COALESCE(EXCLUDED.channel, chats.channel),
        is_group = COALESCE(EXCLUDED.is_group, chats.is_group)
    `;
  }
}

export async function updateChatName(
  chatJid: string,
  name: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO chats (jid, name, last_message_time)
    VALUES (${chatJid}, ${name}, ${now})
    ON CONFLICT (jid) DO UPDATE SET name = EXCLUDED.name
  `;
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

export async function getAllChats(): Promise<ChatInfo[]> {
  return sql<ChatInfo[]>`
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `;
}

export async function getLastGroupSync(): Promise<string | null> {
  const rows =
    await sql`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`;
  return rows[0]?.last_message_time || null;
}

export async function setLastGroupSync(): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO chats (jid, name, last_message_time)
    VALUES ('__group_sync__', '__group_sync__', ${now})
    ON CONFLICT (jid) DO UPDATE SET last_message_time = EXCLUDED.last_message_time
  `;
}

export async function storeMessage(msg: NewMessage): Promise<void> {
  await sql`
    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message, reply_to_message_id, reply_to_message_content, reply_to_sender_name, node_id)
    VALUES (${msg.id}, ${msg.chat_jid}, ${msg.sender}, ${msg.sender_name}, ${msg.content}, ${msg.timestamp}, ${msg.is_from_me ? 1 : 0}, ${msg.is_bot_message ? 1 : 0}, ${msg.reply_to_message_id ?? null}, ${msg.reply_to_message_content ?? null}, ${msg.reply_to_sender_name ?? null}, ${NODE_ID})
    ON CONFLICT (id, chat_jid) DO UPDATE SET
      content = EXCLUDED.content,
      is_bot_message = EXCLUDED.is_bot_message,
      reply_to_message_id = EXCLUDED.reply_to_message_id,
      reply_to_message_content = EXCLUDED.reply_to_message_content,
      reply_to_sender_name = EXCLUDED.reply_to_sender_name
  `;
}

export async function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): Promise<void> {
  await sql`
    INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message)
    VALUES (${msg.id}, ${msg.chat_jid}, ${msg.sender}, ${msg.sender_name}, ${msg.content}, ${msg.timestamp}, ${msg.is_from_me ? 1 : 0}, ${msg.is_bot_message ? 1 : 0})
    ON CONFLICT (id, chat_jid) DO UPDATE SET
      content = EXCLUDED.content,
      is_bot_message = EXCLUDED.is_bot_message
  `;
}

export async function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<{ messages: NewMessage[]; newTimestamp: string }> {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const rows = await sql<NewMessage[]>`
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ${lastTimestamp}
        AND chat_jid = ANY(${jids as unknown as string})
        AND is_bot_message = 0
        AND content NOT LIKE ${`${botPrefix}:%`}
        AND content != ''
        AND content IS NOT NULL
        AND node_id = ${NODE_ID}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    ) sub
    ORDER BY timestamp
  `;

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export async function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): Promise<NewMessage[]> {
  return sql<NewMessage[]>`
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ${chatJid}
        AND timestamp > ${sinceTimestamp}
        AND is_bot_message = 0
        AND content NOT LIKE ${`${botPrefix}:%`}
        AND content != ''
        AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ${limit}
    ) sub
    ORDER BY timestamp
  `;
}

export async function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): Promise<string | undefined> {
  const rows = await sql`
    SELECT MAX(timestamp) as ts FROM messages
    WHERE chat_jid = ${chatJid}
      AND (is_bot_message = 1 OR content LIKE ${`${botPrefix}:%`})
  `;
  return rows[0]?.ts ?? undefined;
}

export async function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): Promise<void> {
  await sql`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (${task.id}, ${task.group_folder}, ${task.chat_jid}, ${task.prompt}, ${task.script || null}, ${task.schedule_type}, ${task.schedule_value}, ${task.context_mode || 'isolated'}, ${task.next_run}, ${task.status}, ${task.created_at})
  `;
}

export async function getTaskById(
  id: string,
): Promise<ScheduledTask | undefined> {
  const rows = await sql<
    ScheduledTask[]
  >`SELECT * FROM scheduled_tasks WHERE id = ${id}`;
  return rows[0];
}

export async function getTasksForGroup(
  groupFolder: string,
): Promise<ScheduledTask[]> {
  return sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks WHERE group_folder = ${groupFolder} ORDER BY created_at DESC
  `;
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  return sql<
    ScheduledTask[]
  >`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`;
}

export async function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): Promise<void> {
  const setValues: Record<string, unknown> = {};

  if (updates.prompt !== undefined) setValues.prompt = updates.prompt;
  if (updates.script !== undefined) setValues.script = updates.script || null;
  if (updates.schedule_type !== undefined)
    setValues.schedule_type = updates.schedule_type;
  if (updates.schedule_value !== undefined)
    setValues.schedule_value = updates.schedule_value;
  if (updates.next_run !== undefined) setValues.next_run = updates.next_run;
  if (updates.status !== undefined) setValues.status = updates.status;

  if (Object.keys(setValues).length === 0) return;

  await sql`UPDATE scheduled_tasks SET ${sql(setValues)} WHERE id = ${id}`;
}

export async function deleteTask(id: string): Promise<void> {
  await sql`DELETE FROM task_run_logs WHERE task_id = ${id}`;
  await sql`DELETE FROM scheduled_tasks WHERE id = ${id}`;
}

export async function getDueTasks(): Promise<ScheduledTask[]> {
  const now = new Date().toISOString();
  return sql<ScheduledTask[]>`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ${now}
    ORDER BY next_run
  `;
}

export async function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): Promise<void> {
  const now = new Date().toISOString();
  if (nextRun === null) {
    await sql`
      UPDATE scheduled_tasks
      SET next_run = NULL, last_run = ${now}, last_result = ${lastResult}, status = 'completed'
      WHERE id = ${id}
    `;
  } else {
    await sql`
      UPDATE scheduled_tasks
      SET next_run = ${nextRun}, last_run = ${now}, last_result = ${lastResult}
      WHERE id = ${id}
    `;
  }
}

export async function logTaskRun(log: TaskRunLog): Promise<void> {
  await sql`
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (${log.task_id}, ${log.run_at}, ${log.duration_ms}, ${log.status}, ${log.result}, ${log.error})
  `;
}

export async function getRouterState(key: string): Promise<string | undefined> {
  const rows = await sql`SELECT value FROM router_state WHERE key = ${key}`;
  return rows[0]?.value;
}

export async function setRouterState(
  key: string,
  value: string,
): Promise<void> {
  await sql`
    INSERT INTO router_state (key, value) VALUES (${key}, ${value})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

export async function getSession(
  groupFolder: string,
): Promise<{ sessionId: string; lastNode: string | null } | undefined> {
  const rows =
    await sql`SELECT session_id, last_node FROM sessions WHERE group_folder = ${groupFolder} AND node_id = ${SESSION_GROUP}`;
  if (!rows[0]) return undefined;
  return { sessionId: rows[0].session_id, lastNode: rows[0].last_node ?? null };
}

export async function setSession(
  groupFolder: string,
  sessionId: string,
): Promise<void> {
  await sql`
    INSERT INTO sessions (group_folder, node_id, session_id, last_node) VALUES (${groupFolder}, ${SESSION_GROUP}, ${sessionId}, ${NODE_ID})
    ON CONFLICT (group_folder, node_id) DO UPDATE SET session_id = EXCLUDED.session_id, last_node = ${NODE_ID}
  `;
}

export async function deleteSession(groupFolder: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE group_folder = ${groupFolder} AND node_id = ${SESSION_GROUP}`;
}

export async function getAllSessions(): Promise<
  Record<string, { sessionId: string; lastNode: string | null }>
> {
  const rows = await sql<
    Array<{
      group_folder: string;
      session_id: string;
      last_node: string | null;
    }>
  >`
    SELECT group_folder, session_id, last_node FROM sessions WHERE node_id = ${SESSION_GROUP}
  `;
  const result: Record<string, { sessionId: string; lastNode: string | null }> =
    {};
  for (const row of rows) {
    result[row.group_folder] = {
      sessionId: row.session_id,
      lastNode: row.last_node ?? null,
    };
  }
  return result;
}

export async function getRegisteredGroup(
  jid: string,
): Promise<(RegisteredGroup & { jid: string }) | undefined> {
  const rows =
    await sql`SELECT * FROM registered_groups WHERE jid = ${jid} AND session_group = ${SESSION_GROUP}`;
  const row = rows[0];
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export async function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): Promise<void> {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  await sql`
    INSERT INTO registered_groups (jid, session_group, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
    VALUES (${jid}, ${SESSION_GROUP}, ${group.name}, ${group.folder}, ${group.trigger}, ${group.added_at}, ${group.containerConfig ? JSON.stringify(group.containerConfig) : null}, ${group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0}, ${group.isMain ? 1 : 0})
    ON CONFLICT (jid, session_group) DO UPDATE SET
      name = EXCLUDED.name,
      folder = EXCLUDED.folder,
      trigger_pattern = EXCLUDED.trigger_pattern,
      added_at = EXCLUDED.added_at,
      container_config = EXCLUDED.container_config,
      requires_trigger = EXCLUDED.requires_trigger,
      is_main = EXCLUDED.is_main
  `;
}

export async function getAllRegisteredGroups(): Promise<
  Record<string, RegisteredGroup>
> {
  const rows =
    await sql`SELECT * FROM registered_groups WHERE session_group = ${SESSION_GROUP}`;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Node registry (multi-instance awareness) ---

export interface NodeInfo {
  id: string;
  hostname: string;
  last_seen: string;
  status: string;
}

export async function registerNode(): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO nodes (id, hostname, last_seen, status)
    VALUES (${NODE_ID}, ${os.hostname()}, ${now}, 'active')
    ON CONFLICT (id) DO UPDATE SET
      hostname = EXCLUDED.hostname,
      last_seen = EXCLUDED.last_seen,
      status = 'active'
  `;
}

export async function updateNodeHeartbeat(): Promise<void> {
  await sql`
    UPDATE nodes SET last_seen = ${new Date().toISOString()} WHERE id = ${NODE_ID}
  `;
}

export async function getActiveNodes(): Promise<NodeInfo[]> {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  return sql<NodeInfo[]>`
    SELECT * FROM nodes WHERE last_seen > ${cutoff} ORDER BY last_seen DESC
  `;
}

// --- JSON migration ---

async function migrateJsonState(): Promise<void> {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      await setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      await setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      await setSession(folder, sessionId);
    }
  }

  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        await setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
