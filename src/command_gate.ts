// src/command_gate.ts
import {
  ChatInputCommandInteraction,
  GuildMember,
  PermissionFlagsBits,
} from "discord.js";
import { pool } from "./db.js";

const OWNER_IDS = ["763620668175941662"]; // you

function isOwner(i: ChatInputCommandInteraction): boolean {
  return OWNER_IDS.includes(i.user.id);
}

function hasAdminLikePerms(i: ChatInputCommandInteraction): boolean {
  if (!i.inGuild()) return false;
  const gm = i.member as GuildMember | null;
  if (!gm?.permissions) return false;

  return (
    gm.permissions.has(PermissionFlagsBits.Administrator) ||
    gm.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

interface CommandPermissionRow {
  guild_id: string;
  command_name: string;
  role_ids: string[];
}

/**
 * Pure check: returns true if this user is allowed to run this command.
 */
export async function checkCommandAllowed(
  i: ChatInputCommandInteraction,
): Promise<boolean> {
  // Must be in a guild for gating to make sense
  if (!i.inGuild()) return false;

  // Always allow /command_roles itself; it enforces its own auth.
  if (i.commandName === "command_roles") return true;

  // Global owner bypass
  if (isOwner(i)) return true;

  // Discord-level bypass
  if (hasAdminLikePerms(i)) return true;

  const guildId = i.guildId!;
  const commandName = i.commandName.toLowerCase();

  try {
    const res = await pool.query(
      "SELECT role_ids FROM command_permissions WHERE guild_id = $1 AND command_name = $2",
      [guildId, commandName],
    );
    const row = (res.rows[0] ?? null) as CommandPermissionRow | null;

    // No rule or empty list → only Admin/ManageGuild/Owner allowed
    if (!row || !row.role_ids || row.role_ids.length === 0) {
      return false;
    }

    const gm = i.member as GuildMember | null;
    const memberRoles = gm?.roles?.cache;
    if (!memberRoles) return false;

    const memberRoleIds = new Set(memberRoles.keys());
    return row.role_ids.some((rid: string) => memberRoleIds.has(rid));
  } catch (err) {
    console.error("[command_gate] error checking permission:", err);
    // Fail-closed for non-admins; admins/owner already bypassed above.
    return false;
  }
}

/**
 * Wrapper: checks and, if denied, sends an ephemeral message.
 * Returns true if allowed, false if blocked.
 */
export async function ensureCommandAllowed(
  i: ChatInputCommandInteraction,
): Promise<boolean> {
  const ok = await checkCommandAllowed(i);
  if (ok) return true;

  try {
    if (!i.deferred && !i.replied) {
      await i.reply({
        ephemeral: true,
        content:
          "You’re not allowed to use this command here.\n" +
          "An admin can configure role access with `/command_roles`.",
      });
    }
  } catch {
    // ignore reply errors
  }
  return false;
}
