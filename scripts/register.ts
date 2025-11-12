import "dotenv/config";
import { REST, Routes } from "discord.js";
import { data as warroom } from "../src/commands/warroom.js";

const token = process.env.DISCORD_BOT_TOKEN!;
const clientId = process.env.DISCORD_CLIENT_ID!;
const guildId = process.env.GUILD_ID;

async function main() {
  const rest = new REST({ version: "10" }).setToken(token);
  const body = [warroom.toJSON()];
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
    console.log("Registered guild commands:", guildId);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log("Registered global commands.");
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
