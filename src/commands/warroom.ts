import {
  SlashCommandBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("warroom")
  .setDescription("Create a War Room (modal collects notes)")
  .addSubcommand((sc) => {
    const withMembers = (idx: number, b: any) =>
      b.addUserOption((o: any) =>
        o.setName(`member${idx}`).setDescription(`Add member #${idx}`).setRequired(false)
      );

    let builder = sc
      .setName("setup")
      .setDescription("Validate target nation, pick members, then enter notes")
      .addStringOption((o) =>
        o
          .setName("target")
          .setDescription("Nation ID or full nation URL")
          .setRequired(true)
      );

    for (let i = 1; i <= 10; i++) builder = withMembers(i, builder);
    return builder;
  });
