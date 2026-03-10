import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import * as dotenv from "dotenv";
import * as db from "./db.ts";
import { HELP_TEXT } from "./help.ts";
import * as readline from "readline";
import { Api } from "telegram";

dotenv.config();

// Helper to handle Telegram IDs as BigInt or string
function parsePeerId(id: string) {
  const clean = id.toString().replace(/['"\s]/g, "");
  if (/^-?\\d+$/.test(clean)) return BigInt(clean);
  return clean;
}

// --- Polling Implementation ---

// Worker function to fetch messages from a source using client.getMessages
async function checkSourceMessages(client: TelegramClient, sourceId: string) {
    const peer = parsePeerId(sourceId);
    const lastMessageId = db.getLastMessageId(sourceId);
    
    try {
        console.log(`Polling source: ${sourceId}. Last ID: ${lastMessageId || 'N/A'}`);

        // Fetch up to 5 recent messages
        const messages = await client.getMessages(peer, { limit: 5 });

        if (!messages.length) {
            if (lastMessageId === null) {
                 // If no messages and no last ID, we do nothing for now to avoid setting a baseline from an empty list if the chat is truly empty.
            }
            return;
        }

        // Messages are returned newest first (index 0 is newest)
        const newMessages: Api.Message[] = [];
        let newLastId: string | number | null = lastMessageId;
        
        for (const message of messages) {
            // Only process messages that are not outgoing and have an ID
            if (message.out || !message.id) continue;

            const currentId = message.id.toString();
            
            if (lastMessageId === null || BigInt(currentId) > BigInt(lastMessageId)) {
                newMessages.push(message);
                // Keep track of the highest ID found so far in this batch (which will be the new last ID if we process all 5)
                if (newLastId === null || BigInt(currentId) > BigInt(newLastId)) {
                     newLastId = currentId;
                }
            } else if (BigInt(currentId) <= BigInt(lastMessageId)) {
                // Since messages are sorted by date/ID descending, once we hit an old ID, we can stop looking.
                break; 
            }
        }
        
        if (newMessages.length > 0) {
            // Reverse to process older messages first in this batch if multiple were found
            newMessages.reverse(); 
            
            console.log(`Found ${newMessages.length} new messages in ${sourceId}. Processing...`);

            // Process found messages using the existing message handler logic
            for (const message of newMessages) {
                await processIncomingMessage(client, message);
            }

            // Update DB with the highest ID found in this successful batch
            if (newLastId !== null) {
                db.setLastMessageId(sourceId, newLastId);
                console.log(`Updated last message ID for \${sourceId} to \${newLastId}\`);
            }
        } else if (lastMessageId === null && messages.length > 0) {
             // Initialization case: If we polled, found messages, but none were *newer* than null, 
             // we set the highest ID found as the starting point. The highest ID is the first message in the array (index 0), provided it's not an outgoing message.
             const firstUsableMessage = messages.find(m => !m.out && m.id);
             if (firstUsableMessage && firstUsableMessage.id) {
                db.setLastMessageId(sourceId, firstUsableMessage.id.toString());
                console.log(\`Initialized last message ID for \${sourceId} to \${firstUsableMessage.id}\`);
             }
        }

    } catch (e: any) {
        console.error(\`Polling error for source \${sourceId}: \${e.message}\`);
    }
}


// Helper function to process a message, extracted from the original NewMessage handler
async function processIncomingMessage(client: TelegramClient, message: Api.Message) {
    if (!message.text) return;

    const chatId = message.chatId?.toString();
    if (!chatId) return;

    const text = message.text.toLowerCase();
    const keywords = db.getKeywords();
    const rawTargetChannelId = db.getTargetChannel();
    
    if (!rawTargetChannelId) {
      return;
    }

    const targetPeer = parsePeerId(rawTargetChannelId);

    for (const keywordRule of keywords) {
      const requiredWords = keywordRule.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
      const isMatch = requiredWords.every(word => text.includes(word));

      if (isMatch && requiredWords.length > 0) {
        console.log("Found match for rule via Polling:", keywordRule);
        db.logMatch(keywordRule, chatId);
        
        let chatName = chatId;
        try {
          const entity = await client.getEntity(parsePeerId(chatId));
          // @ts-ignore
          chatName = entity.title || entity.firstName || chatId;
        } catch (e) {
          console.log("Could not fetch chat name for polled message");
        }

        try {
          const cleanChatId = chatId.replace("-100", "");
          await client.sendMessage(targetPeer, {
            message: \`[POLLING] Found match in \${chatName}:\\n\\n\${message.text}\\n\\nLink: https://t.me/c/\${cleanChatId}/\${message.id}\`,
          });
          console.log(\`Successfully forwarded polled match to target: \${targetPeer}\`);
        } catch (e: any) {
          console.error("Failed to send message to target:", e.message);
          await client.sendMessage("me", { message: \`Error sending to target from polling: \${e.message}\` });
        }
        break; // Match found, no need to check other rules for the same message
      }
    }
}


// Ensure the client knows about entities before they start sending updates
async function cacheMonitoredEntities(client: TelegramClient) {
  const sources = db.getSources();
  console.log(\`Caching \${sources.length} sources...\`);
  
  for (const id of sources) {
    try {
      const peer = parsePeerId(id);
      await client.getEntity(peer);
      console.log(\`Successfully cached source: \${id}\`);
    } catch (e: any) {
      console.error(\`Failed to cache source \${id}: \${e.message}\`);
    }
  }
}

// Main polling worker loop
function startPollingWorker(client: TelegramClient) {
    const POLLING_INTERVAL_MS = 7000; // 7 seconds, between 5 and 10 seconds
    console.log(\`Starting polling worker every \${POLLING_INTERVAL_MS / 1000} seconds...\`);

    setInterval(async () => {
        const sources = db.getSources();
        console.log(\`[POLL TICK] Checking \${sources.length} sources.\`);
        
        // Use Promise.allSettled to continue execution even if one source check fails
        await Promise.allSettled(sources.map(sourceId => checkSourceMessages(client, sourceId)));

    }, POLLING_INTERVAL_MS);
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
  
  // START POLLING WORKER HERE
  startPollingWorker(client);

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
        await client.sendMessage(message.chatId, { message: \`Keyword rule added: \${keywordRule}\` });
        // No need to recache for keywords
      } else {
        await client.sendMessage(message.chatId, { message: \`Please provide a keyword or rule. Example: /add_keyword photo, moscow\` });
      }
    } else if (command === "/list_keywords") {
      const keywords = db.getKeywords();
      if (keywords.length === 0) {
        await client.sendMessage(message.chatId, { message: \`No keywords or rules found.\` });
      } else {
        const formattedKeywords = keywords.map(k => \`- \`\${k}\`\`).join("\n");
        await client.sendMessage(message.chatId, { message: \`**Keywords/Rules:**\\n\${formattedKeywords}\` });
      }
    } else if (command === "/remove_keyword") {
      const keywordRule = text.substring(command.length).trim();
      if (keywordRule) {
        db.removeKeyword(keywordRule);
        await client.sendMessage(message.chatId, { message: \`Keyword rule removed: \${keywordRule}\` });
      } else {
        await client.sendMessage(message.chatId, { message: \`Please provide a keyword or rule to remove.\` });
      }
    } else if (command === "/clean_keywords") {
      db.clearKeywords();
      await client.sendMessage(message.chatId, { message: \`All keyword rules have been cleared.\` });
    } else if (command === "/add_source") {
      const sourceId = parts[1];
      if (sourceId) {
        db.addSource(sourceId);
        try {
          await client.getEntity(parsePeerId(sourceId));
          await client.sendMessage(message.chatId, { message: \`Source added and cached: \${sourceId}\` });
        } catch (e: any) {
          await client.sendMessage(message.chatId, { message: \`Source added to DB but failed to cache entity: \${e.message}\` });
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
          const cleanId = id.replace(/['"\s]/g, '').replace("-100", "");
          return \`- \${name} (https://t.me/c/\${cleanId}/999999)\\n  ID: \`\${id}\`\`;
        } catch (e) {
          return \`- Unknown Group\\n  ID: \`\${id}\`\`;
        }
      }));
      
      if (sourceInfo.length === 0) {
        await client.sendMessage(message.chatId, { message: \`No sources found.\` });
      } else {
        await client.sendMessage(message.chatId, { message: \`**Sources:**\\n\${sourceInfo.join("\n\n")}\` });
      }
    } else if (command === "/remove_source") {
      if (parts[1]) {
        db.removeSource(parts[1]);
        await client.sendMessage(message.chatId, { message: \`Source removed: \${parts[1]}\` });
      } else {
        await client.sendMessage(message.chatId, { message: \`Please provide a source ID to remove.\` });
      }
    } else if (command === "/clean_sources") {
      db.clearSources();
      await client.sendMessage(message.chatId, { message: \`All sources have been cleared.\` });
    } else if (command === "/set_target") {
      db.setTargetChannel(parts[1]);
      await client.sendMessage(message.chatId, { message: \`Target channel set: \${parts[1]}\` });
    } else if (command === "/get_target") {
      const target = db.getTargetChannel();
      await client.sendMessage(message.chatId, { message: \`Current target channel: \${target || "Not set"}\` });
    } else if (command === "/remove_target") {
      db.removeTargetChannel();
      await client.sendMessage(message.chatId, { message: \`Target channel has been removed. You will not receive any alerts until you set a new one.\` });
    } else if (command === "/stats") {
      const stats = db.getStats();
      const statsText = await Promise.all(stats.map(async (s) => {
        try {
          const peerId = parsePeerId(s.source_id);
          const entity = await client.getEntity(peerId);
          // @ts-ignore
          return \`\${s.keyword} in \${entity.title || entity.firstName || "Unknown"}: \${s.count}\`;
        } catch (e) {
          return \`\${s.keyword} in \${s.source_id}: \${s.count}\`;
        }
      }));
      await client.sendMessage(message.chatId, { message: \`Stats (24h):\\n\${statsText.join("\n") || "No data"}\` });
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
    const normalizedChatId = chatId.startsWith("-100") ? chatId : \`-100\${chatId}\`;
    
    // Check if the message comes from one of the monitored sources
    const isMonitored = sources.some(s => {
      const cleanS = s.replace(/['"\s]/g, '');
      const normalizedS = cleanS.startsWith("-100") ? cleanS : \`-100\${cleanS}\`;
      return cleanS === chatId || normalizedS === chatId || cleanS === normalizedChatId || normalizedS === normalizedChatId;
    });

    if (!isMonitored) return;

    console.log(\`Incoming message from monitored chat (Event Listener): \${chatId}\`);

    // Check against polling ID to avoid processing messages already handled by polling (i.e., messages that arrived before the push event did, or when the push event is delayed)
    const currentLastId = db.getLastMessageId(chatId);
    if (message.id && currentLastId && BigInt(message.id) <= BigInt(currentLastId)) {
        console.log(\`Skipping message \${message.id} from \${chatId} as it is not newer than last polled ID (\${currentLastId})\`);
        return;
    }
    
    const text = message.text.toLowerCase();
    const keywords = db.getKeywords();
    const rawTargetChannelId = db.getTargetChannel();
    
    if (!rawTargetChannelId) {
      return;
    }

    const targetPeer = parsePeerId(rawTargetChannelId);

    for (const keywordRule of keywords) {
      const requiredWords = keywordRule.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
      const isMatch = requiredWords.every(word => text.includes(word));

      if (isMatch && requiredWords.length > 0) {
        console.log("Found match for rule via Event Listener:", keywordRule);
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
            message: \`[EVENT] Found match in \${chatName}:\\n\\n\${message.text}\\n\\nLink: https://t.me/c/\${cleanChatId}/\${message.id}\`,
          });
          console.log(\`Successfully forwarded match to target: \${targetPeer}\`);
        } catch (e: any) {
          console.error("Failed to send message to target:", e.message);
          await client.sendMessage("me", { message: \`Error sending to target: \${e.message}\` });
        }
        break; // Match found, no need to check other rules for the same message
      }
    }
    
    // If processed here, update the ID regardless to keep the fast path synced with the slow path baseline
    if (message.id) {
        db.setLastMessageId(chatId, message.id.toString());
        console.log(\`Updated last message ID for \${chatId} to \${message.id} via Event Listener update.\`);
    }
    
  }, new NewMessage({ incoming: true }));

}

startBot().catch(console.error);
