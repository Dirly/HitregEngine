#!/usr/bin/env tsx
/**
 * account-role — make an account staff (a GM or a developer), or a player again.
 *
 *   pnpm -F @hitreg/server account-role <account name>            # show its role
 *   pnpm -F @hitreg/server account-role <account name> gm|dev     # grant
 *   pnpm -F @hitreg/server account-role <account name> player     # revoke
 *   ... [--data <dir>] [--database <url>]                         # the store hitreg-main uses
 *
 * Run ON THE SERVER MACHINE, against the same store as `hitreg-main` (the same
 * --data / --database / HITREG_DATABASE_URL). There is no way to set a role
 * from a client, on purpose. The role reaches the layers in the signed play
 * ticket at the account's NEXT join (re-enter the world, or change zone), and
 * a staff peer's console authority commands (`/give`, `/soulbind`) are then
 * honoured on the server (docs/hosting.md, "Staff accounts").
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAFF_ROLES, type StaffRole } from "@hitreg/core";
import { FileAccountStore } from "../src/persistence/file.js";
import { PostgresStore } from "../src/persistence/postgres.js";
import type { AccountStore } from "../src/persistence/accounts.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

async function main(): Promise<number> {
  const positional: string[] = [];
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i]!.startsWith("--")) i++;
    else positional.push(process.argv[i]!);
  }
  const [name, want] = positional;
  if (!name || (want !== undefined && want !== "player" && !(STAFF_ROLES as readonly string[]).includes(want))) {
    console.error(`usage: account-role <account name> [${[...STAFF_ROLES, "player"].join("|")}] [--data <dir>] [--database <url>]`);
    return 2;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const playground = path.resolve(arg("playground", path.resolve(here, "../../../apps/playground"))!);
  const database = arg("database", process.env["HITREG_DATABASE_URL"]);
  let db: PostgresStore | null = null;
  let accounts: AccountStore;
  if (database) {
    db = new PostgresStore(database);
    accounts = db.accounts;
  } else {
    const dataDir = path.resolve(arg("data", path.join(playground, ".hitreg", "data"))!);
    accounts = new FileAccountStore(dataDir);
    console.log(`accounts: files under ${dataDir}`);
  }
  try {
    const account = await accounts.find(name);
    if (!account) {
      console.error(`no account called "${name}"`);
      return 1;
    }
    if (want === undefined) {
      console.log(`${account.name}: ${account.role ?? "player"}`);
      return 0;
    }
    const next = { ...account };
    if (want === "player") delete next.role;
    else next.role = want as StaffRole;
    if (!(await accounts.update(next, account))) {
      console.error(`${account.name} changed while this ran: try again`);
      return 1;
    }
    console.log(`${account.name}: ${account.role ?? "player"} -> ${next.role ?? "player"} (takes effect at the next join)`);
    return 0;
  } finally {
    await db?.close();
  }
}

process.exit(await main());
