import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "../types/command.js";

/**
 * Load commands from a directory at runtime. 
 * Accepts .ts when running via tsx and .js when running compiled.
 */
export async function loadCommandsFrom(dir: string): Promise<Command[]> {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(".js") || f.endsWith(".ts"))
    .sort();
  const cmds: Command[] = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    const c: Command = (mod.default ?? mod) as Command;
    if (!c?.data || typeof c.execute !== "function" || c.disabled) continue;
    cmds.push(c);
  }
  return cmds;
}
