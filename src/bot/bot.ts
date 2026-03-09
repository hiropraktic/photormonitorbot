import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import * as dotenv from "dotenv";
import * as db from "./db.ts";
import { HELP_TEXT } from "./help.ts";
import * as readline from "readline";

dotenv.config();

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
    console.log("Dialogs fetched successfully. Ready to monitor.");
  } catch (e) {
    console.error("Failed to fetch dialogs on startup:", e);
  }

  // Command handlers
  client.addEventHandler(async (event) => {
    const message = event.message;
    const text = message.text;
    const parts = text.split(" ");
    const command = parts[0];

    if (command === "/add_keyword") {
      const keywordRule = text.substring(command.length).trim();
      if (keywordRule) {
        db.addKeyword(keywordRule);
        await client.sendMessage(message.chatId, { message: `Keyword rule added: ${keywordRule}` });
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
      db.addSource(parts[1]);
      await client.sendMessage(message.chatId, { message: `Source added: ${parts[1]}` });
    } else if (command === "/list_sources") {
      const sources = db.getSources();
      const sourceInfo = await Promise.all(sources.map(async (id) => {
        try {
          // Clean ID and convert to BigInt if numeric
          const cleanId = id.replace(/['"`\s]/g, '');
          const peerId = /^-?\d+$/.test(cleanId) ? BigInt(cleanId) : cleanId;
          
          // Try to get entity directly
          const entity = await client.getEntity(peerId);
          // @ts-ignore
          const name = entity.title || entity.firstName || "Unknown";
          return `- ${name} (https://t.me/c/${cleanId.replace("-100", "")}/999999)\n  ID: \`${cleanId}\``;
        } catch (e) {
          // If that fails, try to find it in dialogs
          try {
            const cleanId = id.replace(/['"`\s]/g, '');
            const dialogs = await client.getDialogs();
            const dialog = dialogs.find(d => d.id.toString() === cleanId || d.id.toString() === cleanId.replace("-100", ""));
            const name = dialog?.title || "Unknown";
            return `- ${name} (https://t.me/c/${cleanId.replace("-100", "")}/999999)\n  ID: \`${cleanId}\``;
          } catch (e2) {
            return `- Unknown Group\n  ID: \`${id}\``;
          }
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
          const cleanId = s.source_id.replace(/['"`\s]/g, '');
          const peerId = /^-?\d+$/.test(cleanId) ? BigInt(cleanId) : cleanId;
          const entity = await client.getEntity(peerId);
          // @ts-ignore
          return `${s.keyword} in ${entity.title || entity.firstName || "Unknown"}: ${s.count}`;
        } catch (e) {
          try {
            const cleanId = s.source_id.replace(/['"`\s]/g, '');
            const dialogs = await client.getDialogs();
            const dialog = dialogs.find(d => d.id.toString() === cleanId || d.id.toString() === cleanId.replace("-100", ""));
            return `${s.keyword} in ${dialog?.title || cleanId}: ${s.count}`;
          } catch (e2) {
            return `${s.keyword} in ${s.source_id}: ${s.count}`;
          }
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
    if (!message) return;
    
    const chatId = message.chatId?.toString();
    if (!chatId) return;

    console.log("Incoming message from chat:", chatId);
    
    const sources = db.getSources().map(s => s.replace(/['"`\s]/g, ''));
    
    // Normalize IDs for comparison (ensure -100 prefix)
    const normalizedChatId = chatId.startsWith("-100") ? chatId : `-100${chatId}`;
    const normalizedSources = sources.map(s => s.startsWith("-100") ? s : `-100${s}`);
    
    // Check if the message comes from one of the monitored sources
    if (!normalizedSources.includes(chatId) && !normalizedSources.includes(normalizedChatId)) {
      console.log("Chat not in sources:", chatId, "Sources:", sources);
      return;
    }

    if (!message.text) return; // Skip messages without text (like stickers, photos without captions)
    const text = message.text.toLowerCase();
    const keywords = db.getKeywords();
    
    // Clean target channel ID
    const rawTargetChannelId = db.getTargetChannel();
    const targetChannelId = rawTargetChannelId ? rawTargetChannelId.replace(/['"`\s]/g, '') : null;
    
    if (!targetChannelId) {
      console.error("Target channel not set!");
      await client.sendMessage("me", { message: "Error: Target channel not set. Use /set_target <id>" });
      return;
    }

    // Convert to BigInt if numeric
    const targetPeer = /^-?\d+$/.test(targetChannelId) ? BigInt(targetChannelId) : targetChannelId;

    for (const keywordRule of keywords) {
      // Split the rule by comma and trim spaces
      const requiredWords = keywordRule.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
      
      // Check if ALL words in the rule are present in the text
      const isMatch = requiredWords.every(word => text.includes(word));

      if (isMatch && requiredWords.length > 0) {
        console.log("Found match for rule:", keywordRule);
        db.logMatch(keywordRule, chatId);
        
        let chatName = chatId;
        try {
          const chat = await message.getChat();
          // @ts-ignore
          chatName = chat?.title || chat?.firstName || chat?.username || chatId;
        } catch (e) {
          console.log("Could not fetch chat name, using ID");
        }

        try {
          await client.sendMessage(targetPeer, {
            message: `Found match in ${chatName}:\n\n${message.text}\n\nLink: https://t.me/c/${chatId.replace("-100", "")}/${message.id}`,
          });
          console.log(`Successfully forwarded match to target: ${targetPeer}`);
        } catch (e) {
          console.error("Failed to send message to target:", e);
          await client.sendMessage("me", { message: `Error sending to target: ${e}` });
        }
        break; // Log only once per message
      }
    }
  }, new NewMessage({})); // Empty config to catch absolutely everything (including channels)
}

startBot().catch(console.error);
