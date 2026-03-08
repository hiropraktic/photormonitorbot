import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import * as dotenv from "dotenv";
import * as db from "./db.ts";
import { HELP_TEXT } from "./help.ts";
import * as readline from "readline";

dotenv.config();

const apiId = parseInt(process.env.TG_API_ID || "0");
const apiHash = process.env.TG_API_HASH || "";
const stringSession = new StringSession(process.env.SESSION_STRING || "");

async function startBot() {
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => process.env.PHONE_NUMBER || "",
    password: async () => process.env.PASSWORD || "",
    phoneCode: async () => {
      if (process.env.PHONE_CODE) return process.env.PHONE_CODE;
      
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      
      return new Promise((resolve) => {
        rl.question("Please enter the code you received: ", (code) => {
          rl.close();
          resolve(code);
        });
      });
    },
    onError: (err) => console.log(err),
  });

  console.log("Bot started!");
  console.log("SESSION_STRING:", client.session.save());

  // Command handlers
  client.addEventHandler(async (event) => {
    const message = event.message;
    const text = message.text;
    const parts = text.split(" ");
    const command = parts[0];

    if (command === "/add_keyword") {
      db.addKeyword(parts[1]);
      await client.sendMessage(message.chatId, { message: `Keyword added: ${parts[1]}` });
    } else if (command === "/list_keywords") {
      const keywords = db.getKeywords();
      await client.sendMessage(message.chatId, { message: `Keywords: ${keywords.join(", ")}` });
    } else if (command === "/add_source") {
      db.addSource(parts[1]);
      await client.sendMessage(message.chatId, { message: `Source added: ${parts[1]}` });
    } else if (command === "/list_sources") {
      const sources = db.getSources();
      const sourceInfo = await Promise.all(sources.map(async (id) => {
        try {
          const entity = await client.getEntity(id);
          // @ts-ignore
          const title = entity.title || entity.firstName || "Unknown";
          return `${title} (https://t.me/c/${id.replace("-100", "")}/999999)`; // Placeholder link
        } catch (e) {
          return `ID: ${id}`;
        }
      }));
      await client.sendMessage(message.chatId, { message: `Sources:\n${sourceInfo.join("\n")}` });
    } else if (command === "/set_target") {
      db.setTargetChannel(parts[1]);
      await client.sendMessage(message.chatId, { message: `Target channel set: ${parts[1]}` });
    } else if (command === "/stats") {
      const stats = db.getStats();
      const statsText = await Promise.all(stats.map(async (s) => {
        try {
          const entity = await client.getEntity(s.source_id);
          // @ts-ignore
          const title = entity.title || entity.firstName || "Unknown";
          return `${s.keyword} in ${title}: ${s.count}`;
        } catch (e) {
          return `${s.keyword} in ${s.source_id}: ${s.count}`;
        }
      }));
      await client.sendMessage(message.chatId, { message: `Stats (24h):\n${statsText.join("\n") || "No data"}` });
    } else if (command === "/help") {
      await client.sendMessage(message.chatId, { message: HELP_TEXT });
    }
  }, new NewMessage({ incoming: true, fromUsers: ["me"] }));

  // Monitoring
  client.addEventHandler(async (event) => {
    const message = event.message;
    console.log("Incoming message from chat:", message.chatId.toString());
    
    const sources = db.getSources();
    
    // Check if the message comes from one of the monitored sources
    if (!sources.includes(message.chatId.toString())) {
      return;
    }

    const text = message.text.toLowerCase();
    const keywords = db.getKeywords();
    const targetChannelId = db.getTargetChannel();

    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        console.log("Found match:", text);
        db.logMatch(keyword, message.chatId.toString());
        await client.sendMessage(targetChannelId, {
          message: `Found match in ${message.chatId}:\n\n${message.text}\n\nLink: https://t.me/c/${message.chatId}/${message.id}`,
        });
        break; // Log only once per message
      }
    }
  }, new NewMessage({ incoming: true, outgoing: true }));
}

startBot().catch(console.error);
