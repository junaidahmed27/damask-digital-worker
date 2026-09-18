/**
 * A small MIME reader, enough for a forwarded message with attachments. The
 * capture connectors are the data first front door and they ship first, so this
 * parses a real RFC 822 message rather than pretending to.
 */

export type Attachment = {
  filename: string;
  contentType: string;
  bytes: number;
  content: Buffer;
};

export type ParsedMail = {
  headers: Record<string, string>;
  from: string;
  fromName: string;
  to: string[];
  subject: string;
  date: Date | undefined;
  messageId: string | undefined;
  inReplyTo: string | undefined;
  text: string;
  attachments: Attachment[];
};

export function parseMail(raw: string): ParsedMail {
  const { headers, body } = splitHeaders(raw);
  const contentType = headers["content-type"] ?? "text/plain";
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];

  let text = "";
  const attachments: Attachment[] = [];

  if (boundary) {
    for (const part of splitParts(body, boundary)) {
      const parsed = splitHeaders(part);
      const partType = parsed.headers["content-type"] ?? "text/plain";
      const disposition = parsed.headers["content-disposition"] ?? "";
      const encoding = (parsed.headers["content-transfer-encoding"] ?? "7bit").toLowerCase();
      const filename =
        disposition.match(/filename="?([^";]+)"?/i)?.[1] ?? partType.match(/name="?([^";]+)"?/i)?.[1];

      if (filename) {
        const content =
          encoding === "base64"
            ? Buffer.from(parsed.body.replace(/\s+/g, ""), "base64")
            : Buffer.from(decodeQuoted(parsed.body, encoding), "utf8");
        attachments.push({
          filename,
          contentType: partType.split(";")[0]?.trim() ?? "application/octet-stream",
          bytes: content.byteLength,
          content,
        });
        continue;
      }

      if (partType.startsWith("text/plain") && !text) text = decodeQuoted(parsed.body, encoding).trim();
    }
  } else {
    text = decodeQuoted(body, (headers["content-transfer-encoding"] ?? "7bit").toLowerCase()).trim();
  }

  const fromHeader = headers.from ?? "";
  return {
    headers,
    from: addressIn(fromHeader),
    fromName: nameIn(fromHeader),
    to: (headers.to ?? "").split(",").map(addressIn).filter(Boolean),
    subject: (headers.subject ?? "").trim(),
    date: headers.date ? new Date(headers.date) : undefined,
    messageId: headers["message-id"],
    inReplyTo: headers["in-reply-to"],
    text,
    attachments,
  };
}

function splitHeaders(raw: string): { headers: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const split = normalized.indexOf("\n\n");
  const headerText = split < 0 ? normalized : normalized.slice(0, split);
  const body = split < 0 ? "" : normalized.slice(split + 2);

  const headers: Record<string, string> = {};
  // Unfold continuation lines before reading the names.
  for (const line of headerText.replace(/\n[ \t]+/g, " ").split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return { headers, body };
}

function splitParts(body: string, boundary: string): string[] {
  return body
    .split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\n?`))
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== "--");
}

function decodeQuoted(text: string, encoding: string): string {
  if (encoding === "base64") return Buffer.from(text.replace(/\s+/g, ""), "base64").toString("utf8");
  if (encoding !== "quoted-printable") return text;
  return text
    .replace(/=\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function addressIn(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

function nameIn(value: string): string {
  const quoted = value.match(/^\s*"?([^"<]+?)"?\s*</);
  return (quoted?.[1] ?? "").trim();
}
