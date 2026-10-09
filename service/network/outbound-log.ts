import { mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { allocateRecordId } from "../runtime/ids.ts";

export interface OutboundRequestRecord {
  conversationId: string;
  turnId: string;
  requestId: string;
  loopId?: string;
  attempt: number;
  method: string;
  endpoint: string;
  body: string;
}

/** Exact serialized provider requests, retained across conversations and service restarts. */
export function saveOutboundRequest(dataDir: string, record: OutboundRequestRecord): string {
  const dir = resolve(dataDir, "provider-requests");
  mkdirSync(dir, { recursive: true });
  const id = allocateRecordId(dataDir, null, "outboundRequest");
  const path = join(dir, `${id}.json`);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ loggedAt: new Date().toISOString(), ...record }), { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);

  const records = readdirSync(dir)
    .filter(name => /^out_\d+\.json$/.test(name))
    .sort((a, b) => Number(a.slice(4, -5)) - Number(b.slice(4, -5)));
  for (const name of records.slice(0, Math.max(0, records.length - 100))) unlinkSync(join(dir, name));
  return path;
}
