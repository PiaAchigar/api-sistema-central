import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, conversations, messages } from "../db/schema";

export type ConversationFilters = {
  channel?: string;
  status?: string;
  assignedAgentId?: string; // uuid | "unassigned"
  q?: string;
};

// Columnas del "item" de conversación (bandeja + detalle), con nombre de contacto.
const listItemColumns = {
  id: conversations.id,
  contactId: conversations.contactId,
  contactName: contacts.name,
  channel: conversations.channel,
  status: conversations.status,
  assignedAgentId: conversations.assignedAgentId,
  messageCount: conversations.messageCount,
  lastMessageAt: conversations.lastMessageAt,
  createdAt: conversations.createdAt,
};

async function selectListItemById(db: Db, id: string) {
  const rows = await db
    .select(listItemColumns)
    .from(conversations)
    .leftJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(eq(conversations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Bandeja: conversaciones con nombre de contacto + preview del último mensaje
 *  (truncado a 120 chars), ordenadas por COALESCE(last_message_at, created_at) desc. */
export async function listConversations(db: Db, filters: ConversationFilters) {
  const conds = [];
  if (filters.channel) conds.push(eq(conversations.channel, filters.channel));
  if (filters.status) conds.push(eq(conversations.status, filters.status));
  if (filters.assignedAgentId === "unassigned") {
    conds.push(isNull(conversations.assignedAgentId));
  } else if (filters.assignedAgentId) {
    conds.push(eq(conversations.assignedAgentId, filters.assignedAgentId));
  }
  if (filters.q) conds.push(ilike(contacts.name, `%${filters.q}%`));

  const lastMessagePreview = sql<string | null>`(
    SELECT LEFT(m.content, 120) FROM messages m
    WHERE m.conversation_id = ${conversations.id}
    ORDER BY m.created_at DESC LIMIT 1
  )`;

  return db
    .select({ ...listItemColumns, lastMessagePreview })
    .from(conversations)
    .leftJoin(contacts, eq(contacts.id, conversations.contactId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(
      desc(sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`),
    );
}

/** Existencia liviana (para validar antes de insertar un mensaje). */
export async function getConversationById(db: Db, id: string) {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Detalle: la conversación (con nombre de contacto) + sus mensajes cronológicos. */
export async function getConversationWithMessages(db: Db, id: string) {
  const conversation = await selectListItemById(db, id);
  if (!conversation) return null;
  const msgs = await db
    .select({
      id: messages.id,
      senderType: messages.senderType,
      content: messages.content,
      mediaUrl: messages.mediaUrl,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));
  return { conversation, messages: msgs };
}

/** Crea o reusa el hilo de (contactId, channel). El índice único garantiza uno solo. */
export async function upsertConversation(
  db: Db,
  data: { contactId: string; channel: string },
) {
  const inserted = await db
    .insert(conversations)
    .values({
      contactId: data.contactId,
      channel: data.channel,
      status: "open",
      messageCount: 0,
    })
    .onConflictDoNothing({ target: [conversations.contactId, conversations.channel] })
    .returning({ id: conversations.id });

  let id = inserted[0]?.id;
  if (!id) {
    const existing = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.contactId, data.contactId),
          eq(conversations.channel, data.channel),
        ),
      )
      .limit(1);
    id = existing[0]!.id;
  }
  return (await selectListItemById(db, id))!;
}

/** Persiste un mensaje del agente y actualiza contadores en la misma transacción. */
export async function addAgentMessage(db: Db, conversationId: string, content: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(messages)
      .values({ conversationId, senderType: "agent", content })
      .returning({
        id: messages.id,
        senderType: messages.senderType,
        content: messages.content,
        mediaUrl: messages.mediaUrl,
        createdAt: messages.createdAt,
      });
    await tx
      .update(conversations)
      .set({
        messageCount: sql`COALESCE(${conversations.messageCount}, 0) + 1`,
        lastMessageAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
    return rows[0]!;
  });
}

/** Igual que addAgentMessage pero del lado del contacto (para simular entrantes
 *  / Fase 6 webhooks). Persiste el mensaje y bumpea contadores. */
export async function addContactMessage(db: Db, conversationId: string, content: string) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(messages)
      .values({ conversationId, senderType: "contact", content })
      .returning({
        id: messages.id,
        senderType: messages.senderType,
        content: messages.content,
        mediaUrl: messages.mediaUrl,
        createdAt: messages.createdAt,
      });
    await tx
      .update(conversations)
      .set({
        messageCount: sql`COALESCE(${conversations.messageCount}, 0) + 1`,
        lastMessageAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
    return rows[0]!;
  });
}

/** Campos mínimos de la conversación para armar el evento del motor. */
export async function getConversationCore(db: Db, id: string) {
  const rows = await db
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      channel: conversations.channel,
    })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateConversation(
  db: Db,
  id: string,
  data: { status?: string; assignedAgentId?: string | null },
) {
  const existing = await getConversationById(db, id);
  if (!existing) return null;
  await db
    .update(conversations)
    .set({
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.assignedAgentId !== undefined
        ? { assignedAgentId: data.assignedAgentId }
        : {}),
    })
    .where(eq(conversations.id, id));
  return selectListItemById(db, id);
}
