// src/commands/command_roles.ts
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  Role,
  EmbedBuilder,
  GuildMember,
} from "discord.js";
import type { Command } from "../types/command.js";
import { pool } from "../db.js";

const OWNER_IDS = ["763620668175941662"];

function isOwner(i: ChatInputCommandInteraction): boolean {
  return OWNER_IDS.includes(i.user.id);
}

function isAdminOrManageGuild(i: ChatInputCommandInteraction): boolean {
  if (!i.inGuild()) return false;
  if (isOwner(i)) return true;

  const gm = i.member as GuildMember | null;
  return (
    !!gm?.permissions?.has(PermissionFlagsBits.Administrator) ||
    !!gm?.permissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

async function requireAuth(i: ChatInputCommandInteraction): Promise<boolean> {
  if (!i.inGuild()) {
    await i.reply({ ephemeral: true, content: "Use this in a server." });
    return false;
  }
  if (!isAdminOrManageGuild(i)) {
    await i.reply({
      ephemeral: true,
      content:
        "Only server Admins or users with **Manage Server** (or the bot owner) can run this.",
    });
    return false;
  }
  return true;
}

interface CommandPermissionRow {
  guild_id: string;
  command_name: string;
  role_ids: string[];
}

export const data = new SlashCommandBuilder()
  .setName("command_roles")
  .setDescription("Manage which roles can run specific commands in this server")
  .addSubcommand((sc) =>
    sc
      .setName("set")
      .setDescription(
        "Set the allowed roles for a command (overwrites existing list)",
      )
      .addStringOption((o) =>
        o
          .setName("command")
          .setDescription("Slash command name (without /)")
          .setRequired(true),
      )
      .addRoleOption((o) =>
        o.setName("role1").setDescription("Allowed role").setRequired(true),
      )
      .addRoleOption((o) =>
        o.setName("role2").setDescription("Allowed role").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role3").setDescription("Allowed role").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role4").setDescription("Allowed role").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role5").setDescription("Allowed role").setRequired(false),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("add")
      .setDescription("Add one or more roles to the allowed list for a command")
      .addStringOption((o) =>
        o
          .setName("command")
          .setDescription("Slash command name (without /)")
          .setRequired(true),
      )
      .addRoleOption((o) =>
        o.setName("role1").setDescription("Role to add").setRequired(true),
      )
      .addRoleOption((o) =>
        o.setName("role2").setDescription("Role to add").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role3").setDescription("Role to add").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role4").setDescription("Role to add").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role5").setDescription("Role to add").setRequired(false),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("remove")
      .setDescription(
        "Remove one or more roles from a command’s allowed list",
      )
      .addStringOption((o) =>
        o
          .setName("command")
          .setDescription("Slash command name (without /)")
          .setRequired(true),
      )
      .addRoleOption((o) =>
        o
          .setName("role1")
          .setDescription("Role to remove")
          .setRequired(true),
      )
      .addRoleOption((o) =>
        o.setName("role2").setDescription("Role to remove").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role3").setDescription("Role to remove").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role4").setDescription("Role to remove").setRequired(false),
      )
      .addRoleOption((o) =>
        o.setName("role5").setDescription("Role to remove").setRequired(false),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("clear")
      .setDescription(
        "Clear the allowed list (blocks everyone except Admin/Manage Server/Owner)",
      )
      .addStringOption((o) =>
        o
          .setName("command")
          .setDescription("Slash command name (without /)")
          .setRequired(true),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("view")
      .setDescription("View which roles are allowed for a command")
      .addStringOption((o) =>
        o
          .setName("command")
          .setDescription("Slash command name (without /)")
          .setRequired(true),
      ),
  )
  .addSubcommand((sc) =>
    sc
      .setName("list")
      .setDescription(
        "List all commands with explicit role rules in this server",
      ),
  );

export async function execute(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand(true);

  const collectRoles = (): string[] => {
    const ids = new Set<string>();
    for (let n = 1; n <= 5; n++) {
      const r = i.options.getRole(`role${n}`) as Role | null;
      if (r) ids.add(r.id);
    }
    return [...ids];
  };

  if (sub === "list") {
    if (!i.inGuild()) {
      await i.reply({ ephemeral: true, content: "Use this in a server." });
      return;
    }

    const res = await pool.query(
      "SELECT command_name, role_ids FROM command_permissions WHERE guild_id = $1 ORDER BY command_name ASC",
      [i.guildId!],
    );
    const rows = res.rows as CommandPermissionRow[];

    if (!rows.length) {
      await i.reply({
        ephemeral: true,
        content: "No role rules are set yet in this server.",
      });
      return;
    }

    const lines = rows.map((r) => {
      const names =
        r.role_ids && r.role_ids.length
          ? r.role_ids.map((id: string) => `<@&${id}>`).join(", ")
          : "(none; blocked for non-staff)";
      return `• **/${r.command_name}** → ${names}`;
    });

    const embed = new EmbedBuilder()
      .setTitle("Command Role Rules")
      .setDescription(lines.join("\n"))
      .setFooter({
        text: "Use /command_roles view|set|add|remove|clear",
      });

    await i.reply({ ephemeral: true, embeds: [embed] });
    return;
  }

  // Everything below this requires Admin/ManageGuild/Owner
  if (!(await requireAuth(i))) return;

  const guildId = i.guildId!;
  const commandName = i.options
    .getString("command")
    ?.trim()
    .toLowerCase() as string;

  if (!commandName) {
    await i.reply({
      ephemeral: true,
      content: "Missing command name.",
    });
    return;
  }

  if (sub === "view") {
    const res = await pool.query(
      "SELECT role_ids FROM command_permissions WHERE guild_id = $1 AND command_name = $2",
      [guildId, commandName],
    );
    const row = (res.rows[0] ?? null) as CommandPermissionRow | null;
    const roles =
      row && row.role_ids && row.role_ids.length
        ? row.role_ids.map((r: string) => `<@&${r}>`).join(", ")
        : "(none; blocked for non-staff)";
    await i.reply({
      ephemeral: true,
      content:
        `Allowed roles for \`/${commandName}\`: ${roles}\n` +
        "Admins/Manage Server and the bot owner always bypass.",
    });
    return;
  }

  if (sub === "clear") {
    await pool.query(
      `INSERT INTO command_permissions (guild_id, command_name, role_ids)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, command_name)
       DO UPDATE SET role_ids = EXCLUDED.role_ids, updated_at = now()`,
      [guildId, commandName, []],
    );
    await i.reply({
      ephemeral: true,
      content:
        `Cleared allowed list for \`/${commandName}\`.\n` +
        "Now only Admins/Manage Server (and the bot owner) can use it until roles are set.",
    });
    return;
  }

  if (sub === "set") {
    const roleIds = collectRoles();
    await pool.query(
      `INSERT INTO command_permissions (guild_id, command_name, role_ids)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, command_name)
       DO UPDATE SET role_ids = EXCLUDED.role_ids, updated_at = now()`,
      [guildId, commandName, roleIds],
    );
    await i.reply({
      ephemeral: true,
      content: `Set \`/${commandName}\` → ${roleIds
        .map((id: string) => `<@&${id}>`)
        .join(", ")}.`,
    });
    return;
  }

  if (sub === "add") {
    const toAdd = new Set<string>(collectRoles());
    if (!toAdd.size) {
      await i.reply({
        ephemeral: true,
        content: "Select at least one role to add.",
      });
      return;
    }

    const res = await pool.query(
      "SELECT role_ids FROM command_permissions WHERE guild_id = $1 AND command_name = $2",
      [guildId, commandName],
    );
    const current =
      ((res.rows[0] ?? null) as CommandPermissionRow | null)?.role_ids ?? [];
    const roleIds = new Set<string>(current);
    for (const r of toAdd) roleIds.add(r);

    await pool.query(
      `INSERT INTO command_permissions (guild_id, command_name, role_ids)
       VALUES ($1, $2, $3)
       ON CONFLICT (guild_id, command_name)
       DO UPDATE SET role_ids = EXCLUDED.role_ids, updated_at = now()`,
      [guildId, commandName, [...roleIds]],
    );

    await i.reply({
      ephemeral: true,
      content: `Added → ${[...toAdd]
        .map((id: string) => `<@&${id}>`)
        .join(", ")} for \`/${commandName}\`.`,
    });
    return;
  }

  if (sub === "remove") {
    const toRemove = new Set<string>(collectRoles());
    if (!toRemove.size) {
      await i.reply({
        ephemeral: true,
        content: "Select at least one role to remove.",
      });
      return;
    }

    const res = await pool.query(
      "SELECT role_ids FROM command_permissions WHERE guild_id = $1 AND command_name = $2",
      [guildId, commandName],
    );
    if (!res.rows.length) {
      await i.reply({
        ephemeral: true,
        content: `No rule exists for \`/${commandName}\`.`,
      });
      return;
    }

    const current =
      ((res.rows[0] as CommandPermissionRow).role_ids ?? []) as string[];
    const roleIds = new Set<string>(current);
    for (const r of toRemove) roleIds.delete(r);

    await pool.query(
      "UPDATE command_permissions SET role_ids = $3, updated_at = now() WHERE guild_id = $1 AND command_name = $2",
      [guildId, commandName, [...roleIds]],
    );

    await i.reply({
      ephemeral: true,
      content: `Removed → ${[...toRemove]
        .map((id: string) => `<@&${id}>`)
        .join(", ")} from \`/${commandName}\`.`,
    });
    return;
  }

  await i.reply({ ephemeral: true, content: "Unknown subcommand." });
}

const command: Command = {
  data,
  execute,
};

export default command;
