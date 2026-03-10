import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import * as dotenv from "dotenv";
import * as db from "./db.ts";
import { HELP_TEXT } from "./help.ts";
import * as readline from "readline";

dotenv.config();

// Helper to handle Telegram IDs as BigInt or string
function parsePeerId(id: string) {
  const clean = id.toString().replace(/['"`\s]/g, "");
  if (/^-?\d+$/.test(clean)) return BigInt(clean);
  return clean;
}

// Ensure the client knows about entities before they start sending updates
async function cacheMonitoredEntities(client: TelegramClient) {
  const sources = db.getSources();
  console.log(`Caching ${sources.length} sources...`);
  
  for (const id of sources) {
    try {
      const peer = parsePeerId(id);
      await client.getEntity(peer);
      console.log(`Successfully cached source: ${id}`);
    } catch (e: any) {
      console.error(`Failed to cache source ${id}: ${e.message}`);
    }
  }
}

// Clean up any dirty data in the database on startup
db.cleanDatabase();

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

  // Fetch dialogs to ensure the client subscribes to channel/megagroup updates
  console.log("Fetching dialogs to enable channel updates...");
  try {
    await client.getDialogs();
    await cacheMonitoredEntities(client);
    console.log("Dialogs and entities cached successfully. Ready to monitor.");
  } catch (e) {
    console.error("Failed to fetch dialogs or entities on startup:", e);
  }

  // Command handlers (only for the user themselves)
  client.addEventHandler(async (event) => {
    const { message } = event;
    const text = message.text;
    if (!text) return;
    
    const parts = text.split(" ");
    const command = parts[0];

    if (command === "/add_keyword") {
      const keywordRule = text.substring(command.length).trim();
      if (keywordRule) {
        db.addKeyword(keywordRule);
        await client.sendMessage(message.chatId, { message: `Keyword rule added: ${keywordRule}` });
        // No need to recache for keywords
      } else {
        await client.sendMessage(message.chatId, { message: `Please provide a keyword or rule. Example: /add_keyword photo, moscow` });
      }
    } else if (command === "/list_keywords") {
      const keywords = db.getKeywords();
      if (keywords.length === 0) {
        await client.sendMessage(message.chatId, { message: `No keywords or rules found.` });
      } else {
        const formattedKeywords = keywords.map(k => `- \`${k}\``).join("\n");
        await client.sendMessage(message.chatId, { message: `**Keywords/Rules:**\n${formattedKeywords}` });
      }
    } else if (command === "/remove_keyword") {
      const keywordRule = text.substring(command.length).trim();
      if (keywordRule) {
        db.removeKeyword(keywordRule);
        await client.sendMessage(message.chatId, { message: `Keyword rule removed: ${keywordRule}` });
      } else {
        await client.sendMessage(message.chatId, { message: `Please provide a keyword or rule to remove.` });
      }
    } else if (command === "/clean_keywords") {
      db.clearKeywords();
      await client.sendMessage(message.chatId, { message: `All keyword rules have been cleared.` });
    } else if (command === "/add_source") {
      const sourceId = parts[1];
      if (sourceId) {
        db.addSource(sourceId);
        try {
          await client.getEntity(parsePeerId(sourceId));
          await client.sendMessage(message.chatId, { message: `Source added and cached: ${sourceId}` });
        } catch (e: any) {
          await client.sendMessage(message.chatId, { message: `Source added to DB but failed to cache entity: ${e.message}` });
        }
      }
    } else if (command === "/list_sources") {
      const sources = db.getSources();
      const sourceInfo = await Promise.all(sources.map(async (id) => {
        try {
          const peerId = parsePeerId(id);
          const entity = await client.getEntity(peerId);
          // @ts-ignore
          const name = entity.title || entity.firstName || "Unknown";
          const cleanId = id.replace(/['"`\s]/g, '').replace("-100", "");
          return `- ${name} (https://t.me/c/${cleanId}/999999)\n  ID: \`${id}\``;
        } catch (e) {
          return `- Unknown Group\n  ID: \`${id}\``;
        }
      }));
      
      if (sourceInfo.length === 0) {
        await client.sendMessage(message.chatId, { message: `No sources found.` });
      } else {
        await client.sendMessage(message.chatId, { message: `**Sources:**\n${sourceInfo.join("\n\n")}` });
      }
    } else if (command === "/remove_source") {
      if (parts[1]) {
        db.removeSource(parts[1]);
        await client.sendMessage(message.chatId, { message: `Source removed: ${parts[1]}` });
      } else {
        await client.sendMessage(message.chatId, { message: `Please provide a source ID to remove.` });
      }
    } else if (command === "/clean_sources") {
      db.clearSources();
      await client.sendMessage(message.chatId, { message: `All sources have been cleared.` });
    } else if (command === "/set_target") {
      db.setTargetChannel(parts[1]);
      await client.sendMessage(message.chatId, { message: `Target channel set: ${parts[1]}` });
    } else if (command === "/get_target") {
      const target = db.getTargetChannel();
      await client.sendMessage(message.chatId, { message: `Current target channel: ${target || "Not set"}` });
    } else if (command === "/remove_target") {
      db.removeTargetChannel();
      await client.sendMessage(message.chatId, { message: `Target channel has been removed. You will not receive any alerts until you set a new one.` });
    } else if (command === "/stats") {
      const stats = db.getStats();
      const statsText = await Promise.all(stats.map(async (s) => {
        try {
          const peerId = parsePeerId(s.source_id);
          const entity = await client.getEntity(peerId);
          // @ts-ignore
          return `${s.keyword} in ${entity.title || entity.firstName || "Unknown"}: ${s.count}`;
        } catch (e) {
          return `${s.keyword} in ${s.source_id}: ${s.count}`;
        }
      }));
      await client.sendMessage(message.chatId, { message: `Stats (24h):\n${statsText.join("\n") || "No data"}` });
    } else if (command === "/help") {
      await client.sendMessage(message.chatId, { message: HELP_TEXT });
    }
  }, new NewMessage({ incoming: true, fromUsers: ["me"] }));

  // Monitoring incoming messages from other users
  client.addEventHandler(async (event) => {
    const { message } = event;
    if (!message || !message.text || message.out) return;

    const chatId = event.chatId?.toString();
    if (!chatId) return;

    const sources = db.getSources();
    const normalizedChatId = chatId.startsWith("-100") ? chatId : `-100${chatId}`;
    
    // Check if the message comes from one of the monitored sources
    const isMonitored = sources.some(s => {
      const cleanS = s.replace(/['"`\s]/g, '');
      const normalizedS = cleanS.startsWith("-100") ? cleanS : `-100${cleanS}`;
      return cleanS === chatId || normalizedS === chatId || cleanS === normalizedChatId || normalizedS === normalizedChatId;
    });

    if (!isMonitored) return;

    console.log(`Incoming message from monitored chat: ${chatId}`);

    const text = message.text.toLowerCase();
    const keywords = db.getKeywords();
    const rawTargetChannelId = db.getTargetChannel();
    
    if (!rawTargetChannelId) {
      // Don't spam "me" for every message, just log it once in a while or keep silent
      return;
    }

    const targetPeer = parsePeerId(rawTargetChannelId);

    for (const keywordRule of keywords) {
      const requiredWords = keywordRule.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
      const isMatch = requiredWords.every(word => text.includes(word));

      if (isMatch && requiredWords.length > 0) {
        console.log("Found match for rule:", keywordRule);
        db.logMatch(keywordRule, chatId);
        
        let chatName = chatId;
        try {
          const entity = await client.getEntity(parsePeerId(chatId));
          // @ts-ignore
          chatName = entity.title || entity.firstName || chatId;
        } catch (e) {
          console.log("Could not fetch chat name for message");
        }

        try {
          const cleanChatId = chatId.replace("-100", "");
          await client.sendMessage(targetPeer, {
            message: `Found match in ${chatName}:\n\n${message.text}\n\nLink: https://t.me/c/${cleanChatId}/${message.id}`,
          });
          console.log(`Successfully forwarded match to target: ${targetPeer}`);
        } catch (e: any) {
          console.error("Failed to send message to target:", e.message);
          await client.sendMessage("me", { message: `Error sending to target: ${e.message}` });
        }
        break; // Match found, no need to check other rules for the same message
      }
    }
  }, new NewMessage({ incoming: true }));
}

startBot().catch(console.error);
