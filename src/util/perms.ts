import {
  Guild,
  OverwriteResolvable,
  PermissionFlagsBits,
} from "discord.js";

export function warroomOverwrites(opts: {
  guild: Guild;
  botId: string;
  openerId: string;
  initialMemberIds: string[];
}): OverwriteResolvable[] {
  const everyone = opts.guild.roles.everyone;

  const base: OverwriteResolvable[] = [
    {
      id: everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    {
      id: opts.botId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    },
    {
      id: opts.openerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  const members: OverwriteResolvable[] = opts.initialMemberIds.map((id) => ({
    id,
    allow: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  }));

  return [...base, ...members];
}
