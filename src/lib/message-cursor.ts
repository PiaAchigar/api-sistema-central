export type MessageCursor = { createdAt: Date; id: string };

export function encodeMessageCursor(cursor: MessageCursor): string {
  return `${cursor.createdAt.toISOString()}_${cursor.id}`;
}

export function decodeMessageCursor(raw: string): MessageCursor {
  const sep = raw.lastIndexOf("_");
  if (sep === -1) throw new Error(`Cursor inválido: ${raw}`);
  const iso = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
    throw new Error(`Cursor inválido: ${raw}`);
  }
  return { createdAt, id };
}
