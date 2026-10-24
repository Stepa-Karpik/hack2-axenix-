import { expect, type APIRequestContext } from "@playwright/test";
import { deflateRawSync, inflateRawSync } from "node:zlib";

export type Snapshot = {
  id: string;
  bundleHash: string;
  directories?: string[];
  files: { path: string; canonicalText: string; sourceHash: string }[];
};
export const source = `public class Main {
  public static void main(String[] args) { System.out.println(answer()); }
  static int first() { return 1; }
  static int answer() { int marker = 42; return marker; }
}\n`;

export async function headers(
  request: APIRequestContext,
  head?: string,
  key = crypto.randomUUID(),
) {
  const response = await request.get("/api/v1/session");
  expect(response.ok()).toBe(true);
  const session = (await response.json()).data;
  return {
    Origin: "http://127.0.0.1:5174",
    "X-CSRF-Token": session.csrfToken,
    "Idempotency-Key": key,
    ...(head === undefined ? {} : { "If-Match": head }),
  };
}

export async function fixture(request: APIRequestContext) {
  const created = await request.post("/api/v1/projects", {
    headers: await headers(request),
    data: { name: "Files acceptance " + crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const projectId = (await created.json()).data.id as string;
  const base = "/api/v1/projects/" + projectId;
  const saved = await request.post(base + "/revisions", {
    headers: await headers(request, "empty"),
    data: {
      files: [
        { path: "Main.java", content: source },
        { path: "notes.txt", content: "keep exact café\n" },
      ],
      directories: ["empty"],
      intent: "semantic_edit",
    },
  });
  expect(saved.status()).toBe(201);
  const original = (await saved.json()).data as Snapshot;
  return { projectId, base, original };
}

export async function head(
  request: APIRequestContext,
  base: string,
): Promise<Snapshot> {
  const project = (await (await request.get(base)).json()).data;
  const response = await request.get(
    base + "/revisions/" + project.headRevisionId,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()).data;
}

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Real ZIP records, including duplicate names and deflate, exercise the HTTP parser.
export function zip(
  entries: { path: string; text?: string; deflate?: boolean }[],
): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path),
      body = Buffer.from(entry.text ?? "");
    const compressed = entry.deflate ? deflateRawSync(body) : body;
    const method = entry.deflate ? 8 : 0,
      crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    central.push(cd, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Parse central records independently of the server's exporter (which uses descriptors).
export function unzip(bytes: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = bytes.readUInt16LE(end + 10);
  let position = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    expect(bytes.readUInt32LE(position)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(position + 10),
      length = bytes.readUInt32LE(position + 20);
    const nameLength = bytes.readUInt16LE(position + 28),
      extra = bytes.readUInt16LE(position + 30),
      comment = bytes.readUInt16LE(position + 32);
    const name = bytes
      .subarray(position + 46, position + 46 + nameLength)
      .toString("utf8");
    const local = bytes.readUInt32LE(position + 42),
      start =
        local +
        30 +
        bytes.readUInt16LE(local + 26) +
        bytes.readUInt16LE(local + 28);
    const body = bytes.subarray(start, start + length);
    expect([0, 8]).toContain(method);
    expect(result).not.toHaveProperty(name);
    result[name] = (method === 8 ? inflateRawSync(body) : body).toString(
      "utf8",
    );
    position += 46 + nameLength + extra + comment;
  }
  return result;
}
