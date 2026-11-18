import fs from "node:fs";
import path from "node:path";
import type { SecretBox } from "../account/vault.js";

export interface TeamSession {
  apiBaseUrl: string;
  token: string;
  expiresAt: string;
}

interface StoredSession {
  version: 1;
  encrypted: true;
  data: string;
}

/** Team member sessions are only persisted through Electron's OS-backed safeStorage. */
export class TeamSessionVault {
  constructor(readonly file: string, private readonly box: () => SecretBox | undefined) {}

  load(): TeamSession | undefined {
    if (!fs.existsSync(this.file)) return undefined;
    const stored = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<StoredSession>;
    if (stored.version !== 1 || stored.encrypted !== true || typeof stored.data !== "string") throw new Error("Team session file is invalid");
    const box = this.box();
    if (!box) throw new Error("Secure credential storage is unavailable");
    const session = JSON.parse(box.decrypt(Buffer.from(stored.data, "base64"))) as Partial<TeamSession>;
    if (typeof session.token !== "string" || !session.token || typeof session.apiBaseUrl !== "string" || typeof session.expiresAt !== "string") {
      throw new Error("Team session data is incomplete");
    }
    return session as TeamSession;
  }

  save(session: TeamSession): void {
    const box = this.box();
    if (!box) throw new Error("Secure credential storage is unavailable; team sign-in cannot be saved on this device");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = box.encrypt(JSON.stringify(session)).toString("base64");
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, encrypted: true, data } satisfies StoredSession) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
