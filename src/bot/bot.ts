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
function parsePeerId(id: string | number | bigint): any {
  if (id === undefined || id === null) return "";
  const clean = id.toString().replace(/['"\s]/g, "");
  if (/^-?\d+$/.test(clean)) return BigInt(clean);
  return clean;
}

// --- Polling Implementation ---

// Worker function to fetch messages from a source using client.getMessages
async function checkSourceMessages(client: TelegramClient, sourceId: string) {
    if (!sourceId) return;
    const peer = parsePeerId(sourceId);
    const lastMessageId = db.getLastMessageId(sourceId);
    
    try {
        console.log(`[POLL] Polling source: ${sourceId}. Last ID: ${lastMessageId || 'N/A'}`);

        // Fetch up to 100 recent messages if we have a baseline, otherwise fetch 2 to initialize
        const fetchLimit = lastMessageId ? 100 : 2;
        const fetchConfig: any = { limit: fetchLimit };
        
        if (lastMessageId) {
            // Tell MTProto to only give us messages strictly newer than our last processed ID
            fetchConfig.minId = parseInt(lastMessageId);
        }

        // @ts-ignore
        const messages = await client.getMessages(peer, fetchConfig);

        if (!messages.length) {
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
                // Keep track of the highest ID found so far in this batch
                if (newLastId === null || BigInt(currentId) > BigInt(newLastId)) {
                     newLastId = currentId;
                }
            } else if (BigInt(currentId) <= BigInt(lastMessageId)) {
                // Since messages are sorted by date/ID descending, once we hit an old ID, we can stop looking.
                break; 
            }
        }
        
        if (newMessages.length > 0) {
            // MUST reverse to process older messages first so we go in chronological order
            newMessages.reverse(); 
            
            console.log(`[POLL] Found ${newMessages.length} new messages in ${sourceId}. Processing chronologically...`);

            // Process found messages using the existing message handler logic
            for (const message of newMessages) {
                if (message.text) {
                     console.log(`[POLL] Chat: ${sourceId}, fetched new msg: "${message.text.substring(0, 50).replace(/\n/g, ' ')}..."`);
                } else {
                     console.log(`[POLL] Chat: ${sourceId}, fetched new msg (no text)`);
                }
                
                // Only process text messages through the keyword filter
                if (message.text) {
                     await processIncomingMessage(client, message, "POLLING");
                }
            }

            // Update DB with the highest ID found in this successful batch
            if (newLastId !== null) {
                db.setLastMessageId(sourceId, newLastId);
                console.log(`[POLL] Updated last message ID for ${sourceId} to ${newLastId}`);
            }
        } else if (lastMessageId === null && messages.length > 0) {
             // Initialization case: First run, set the newest message as our baseline
             const firstUsableMessage = messages.find(m => !m.out && m.id);
             if (firstUsableMessage && firstUsableMessage.id) {
                db.setLastMessageId(sourceId, firstUsableMessage.id.toString());
                console.log(`[POLL] Initialized last message ID for ${sourceId} to ${firstUsableMessage.id}`);
             }
        }

    } catch (e: any) {
        console.error(`[POLL] Polling error for source ${sourceId}: ${e.message}`);
    }
}


// Helper function to process a message, extracted from the original NewMessage handler
async function processIncomingMessage(client: TelegramClient, message: Api.Message, sourcePrefix: string = "EVENT") {
    if (!message.text) return;

    // Use message.peerId for a more reliable chat ID if event.chatId fails or is inconsistent
    let rawChatId = message.chatId?.toString();
    if (!rawChatId && message.peerId) {
        // Construct string ID from peer object
        if (message.peerId.className === 'PeerChannel') {
             // @ts-ignore
             rawChatId = `-100${message.peerId.channelId.toString()}`;
        } else if (message.peerId.className === 'PeerChat') {
             // @ts-ignore
             rawChatId = `-${message.peerId.chatId.toString()}`;
        } else if (message.peerId.className === 'PeerUser') {
             // @ts-ignore
             rawChatId = message.peerId.userId.toString();
        }
    }

    if (!rawChatId) {
         console.log(`[${sourcePrefix}] Cannot determine Chat ID for message ${message.id}. Skipping.`);
         return;
    }
    
    const chatId = rawChatId;

    const text = message.text.toLowerCase();
    const keywords = db.getKeywords();
    const rawTargetChannelId = db.getTargetChannel();
    
    if (!rawTargetChannelId) {
      console.log(`[${sourcePrefix}] Target channel not set. Skipping message processing.`);
      return;
    }

    const targetPeer = parsePeerId(rawTargetChannelId);
    
    console.log(`\n[${sourcePrefix}] --- STARTING FILTER CHECK ---`);
    console.log(`[${sourcePrefix}] Chat ID: ${chatId}`);
    console.log(`[${sourcePrefix}] Original Text: "${message.text.substring(0, 50).replace(/\n/g, ' ')}..."`);
    console.log(`[${sourcePrefix}] Lowercased Text: "${text.substring(0, 50).replace(/\n/g, ' ')}..."`);

    let matchedRule: string | null = null;

    for (const keywordRule of keywords) {
      // Split by comma, trim spaces, convert to lowercase, and remove empty strings
      const requiredWords = keywordRule.split(',').map(w => w.trim().toLowerCase()).filter(w => w.length > 0);
      
      console.log(`[${sourcePrefix}] Checking Rule: "${keywordRule}"`);
      console.log(`[${sourcePrefix}] Parsed Words Array:`, requiredWords);

      if (requiredWords.length === 0) {
          console.log(`[${sourcePrefix}] Rule is empty after parsing. Skipping.`);
          continue;
      }

      let allWordsFound = true;
      for (const word of requiredWords) {
          const isFound = text.includes(word);
          console.log(`[${sourcePrefix}] - Checking word: "${word}" -> Found: ${isFound}`);
          if (!isFound) {
              allWordsFound = false;
              break; // Optimization: If one word fails, the AND rule fails
          }
      }

      if (allWordsFound) {
        matchedRule = keywordRule;
        console.log(`[${sourcePrefix}] => MATCH FOUND for rule: "${matchedRule}"`);
        break; // Match found, no need to check other rules for the same message
      } else {
        console.log(`[${sourcePrefix}] => Rule "${keywordRule}" failed.`);
      }
    }
    
    console.log(`[${sourcePrefix}] --- FILTER CHECK COMPLETE ---`);

    if (matchedRule) {
        db.logMatch(matchedRule, chatId);
        
        let chatName = chatId;
        try {
          const entity = await client.getEntity(parsePeerId(chatId));
          // @ts-ignore
          chatName = entity.title || entity.firstName || chatId;
        } catch (e) {
          console.log(`[${sourcePrefix}] Could not fetch chat name for message`);
        }

        try {
          const cleanChatId = chatId.replace("-100", "");
          await client.sendMessage(targetPeer, {
            message: `[${sourcePrefix}] Found match in ${chatName}:\n\n${message.text}\n\nLink: https://t.me/c/${cleanChatId}/${message.id}`,
          });
          console.log(`[${sourcePrefix}] Successfully forwarded match to target: ${targetPeer}`);
        } catch (e: any) {
          console.error(`[${sourcePrefix}] Failed to send message to target:`, e.message);
          try {
             await client.sendMessage("me", { message: `[Bot Error] Failed to send match to target channel. Error: ${e.message}\nRule: ${matchedRule}\nOriginal chat: ${chatName}` });
             console.log(`[${sourcePrefix}] Error notification sent to 'me'`);
          } catch (meErr: any) {
             console.error(`[${sourcePrefix}] CRITICAL: Failed to send error notification to 'me':`, meErr.message);
          }
        }
    }
}


// Ensure the client knows about entities before they start sending updates
async function cacheMonitoredEntities(client: TelegramClient) {
  const sources = db.getSources();
  console.log(`Caching ${sources.length} sources...`);
  
  for (const id of sources) {
    if (!id) continue;
    try {
      const peer = parsePeerId(id);
      await client.getEntity(peer);
      console.log(`Successfully cached source: ${id}`);
    } catch (e: any) {
      console.error(`Failed to cache source ${id}: ${e.message}`);
    }
  }
}

// Main polling worker loop
function startPollingWorker(client: TelegramClient) {
    const POLLING_INTERVAL_MS = 7000; // 7 seconds, between 5 and 10 seconds
    console.log(`Starting polling worker every ${POLLING_INTERVAL_MS / 1000} seconds...`);

    setInterval(async () => {
        const sources = db.getSources();
        if (sources.length > 0) {
           console.log(`[POLL TICK] Checking ${sources.length} sources.`);
           // Use Promise.allSettled to continue execution even if one source check fails
           await Promise.allSettled(sources.map(sourceId => checkSourceMessages(client, sourceId)));
        }
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
          const cleanId = id.replace(/['"\s]/g, '').replace("-100", "");
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

    // Use same reliable logic as processIncomingMessage to get Chat ID
    let rawChatId = event.chatId?.toString();
    if (!rawChatId && message.peerId) {
        if (message.peerId.className === 'PeerChannel') {
             // @ts-ignore
             rawChatId = `-100${message.peerId.channelId.toString()}`;
        } else if (message.peerId.className === 'PeerChat') {
             // @ts-ignore
             rawChatId = `-${message.peerId.chatId.toString()}`;
        } else if (message.peerId.className === 'PeerUser') {
             // @ts-ignore
             rawChatId = message.peerId.userId.toString();
        }
    }
    
    if (!rawChatId) return;
    const chatId = rawChatId;

    const sources = db.getSources();
    const normalizedChatId = chatId.startsWith("-100") ? chatId : `-100${chatId}`;
    
    // Check if the message comes from one of the monitored sources
    const isMonitored = sources.some(s => {
      if (!s) return false;
      const cleanS = s.replace(/['"\s]/g, '');
      const normalizedS = cleanS.startsWith("-100") ? cleanS : `-100${cleanS}`;
      return cleanS === chatId || normalizedS === chatId || cleanS === normalizedChatId || normalizedS === normalizedChatId;
    });

    if (!isMonitored) return;

    console.log(`[EVENT] Incoming message from monitored chat: ${chatId}`);

    // Check against polling ID to avoid processing messages already handled by polling
    const currentLastId = db.getLastMessageId(chatId);
    if (message.id && currentLastId && BigInt(message.id) <= BigInt(currentLastId)) {
        console.log(`[EVENT] Skipping message ${message.id} from ${chatId} as it is not newer than last polled ID (${currentLastId})`);
        return;
    }
    
    await processIncomingMessage(client, message, "EVENT");
    
    // If processed here, update the ID regardless to keep the fast path synced with the slow path baseline
    if (message.id) {
        db.setLastMessageId(chatId, message.id.toString());
        console.log(`[EVENT] Updated last message ID for ${chatId} to ${message.id}`);
    }
    
  }, new NewMessage({ incoming: true }));

}

startBot().catch(console.error);
