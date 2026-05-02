import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSIONS_FILE = path.join(__dirname, 'src', 'data', 'sessions.json');

// Threshold to split sessions (e.g., 2 hours = 2 * 60 * 60 * 1000 ms)
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;

function parseDateStr(dateStr, timeStr) {
  // Try to parse WhatsApp date (DD/MM/YYYY or MM/DD/YYYY or DD.MM.YYYY)
  // To be safe and simple, we can try replacing . with / and passing it to Date
  // But DD/MM/YYYY in JS Date constructor depends on locale.
  // Let's manually parse it.

  let parts = dateStr.split(/[\/\.]/);
  let day, month, year;

  if (parts[2].length >= 2) {
    year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
    // European/Turkish is mostly DD/MM/YYYY. US is MM/DD/YYYY.
    // If parts[1] > 12, it must be DD/MM/YYYY.
    if (parseInt(parts[1]) > 12) {
      day = parts[1];
      month = parts[0];
    } else {
      // Default to DD/MM/YYYY for Europe
      day = parts[0];
      month = parts[1];
    }
  }

  // Clean up time AM/PM
  let isPM = timeStr.toLowerCase().includes('pm');
  let timeClean = timeStr.replace(/\s?[AaPp][Mm]/i, '').trim();
  let timeParts = timeClean.split(':');
  let hour = parseInt(timeParts[0]);
  let min = parseInt(timeParts[1]);
  let sec = timeParts[2] ? parseInt(timeParts[2]) : 0;

  if (isPM && hour < 12) hour += 12;
  if (!isPM && hour === 12) hour = 0;

  // Format: YYYY-MM-DDTHH:mm:ssZ
  const pad = (n) => n.toString().padStart(2, '0');
  const isoStr = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}:${pad(sec)}`;
  const dateObj = new Date(isoStr);

  // If parsing fails, just return current date
  if (isNaN(dateObj.getTime())) {
    return new Date();
  }
  return dateObj;
}

function processWhatsAppExport(filePath, userName, aiName) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const lines = fileContent.split('\n');

  // Regex for iOS and Android WhatsApp formats
  const msgRegex = /^\[?((\d{1,2})[\/\.](\d{1,2})[\/\.](\d{2,4}))[,\s]\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\]?\s*[-:]?\s*([^:]+):\s*(.*)$/;

  let parsedMessages = [];
  let currentMsg = null;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    const match = line.match(msgRegex);
    if (match) {
      // Push previous message if exists
      if (currentMsg) {
        parsedMessages.push(currentMsg);
      }

      const dateStr = match[1];
      const timeStr = match[5];
      let sender = match[6].trim();
      let content = match[7].trim();

      // Remove RTL marks and invisible chars that WhatsApp sometimes adds
      sender = sender.replace(/[\u200E\u200F\u202A-\u202E]/g, '');

      // System messages detection (e.g. changed security code, deleted message)
      if (content.includes('Messages and calls are end-to-end encrypted') ||
        content === 'This message was deleted' ||
        content === 'You deleted this message') {
        currentMsg = null;
        continue;
      }

      let role = null;
      if (sender.toLowerCase().includes(userName.toLowerCase())) {
        role = 'user';
      } else if (sender.toLowerCase().includes(aiName.toLowerCase())) {
        role = 'ai';
      }

      if (role) {
        currentMsg = {
          role,
          content,
          timestamp: parseDateStr(dateStr, timeStr).getTime()
        };
      } else {
        // Skip messages from unknown senders in groups
        currentMsg = null;
      }
    } else {
      // Continuation of the previous message
      if (currentMsg) {
        currentMsg.content += '\n' + line;
      }
    }
  }

  if (currentMsg) {
    parsedMessages.push(currentMsg);
  }

  return parsedMessages;
}

function groupIntoSessions(messages) {
  let sessions = [];
  let currentSession = null;

  for (const msg of messages) {
    if (!currentSession) {
      currentSession = {
        id: `sess-wa-${msg.timestamp}`,
        name: `WhatsApp Import: ${new Date(msg.timestamp).toLocaleDateString()}`,
        timestamp: msg.timestamp,
        messages: [msg]
      };
    } else {
      const lastMsg = currentSession.messages[currentSession.messages.length - 1];
      if (msg.timestamp - lastMsg.timestamp > SESSION_GAP_MS) {
        // Push the old session
        sessions.push(currentSession);
        // Create new session
        currentSession = {
          id: `sess-wa-${msg.timestamp}`,
          name: `WhatsApp Import: ${new Date(msg.timestamp).toLocaleDateString()}`,
          timestamp: msg.timestamp,
          messages: [msg]
        };
      } else {
        currentSession.messages.push(msg);
      }
    }
  }

  if (currentSession) {
    sessions.push(currentSession);
  }

  return sessions;
}

function saveSessions(newSessions) {
  let existingSessions = [];
  if (fs.existsSync(SESSIONS_FILE)) {
    existingSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf-8'));
  }

  // Find if there are already imported sessions to avoid double import (optional)
  // For now, just append them.
  const merged = existingSessions.concat(newSessions);

  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(merged, null, 2));
  console.log(`Successfully added ${newSessions.length} sessions (containing ${newSessions.reduce((acc, s) => acc + s.messages.length, 0)} messages) to ${SESSIONS_FILE}`);
}

const args = process.argv.slice(2);
if (args.length < 3) {
  console.log("Usage: node import-whatsapp.js <path-to-whatsapp-txt> <user-sender-name> <ai-sender-name>");
  console.log("Example: node import-whatsapp.js raw-data/whatsapp/ceren.txt \"Selin\" \"Ceren\"");
  process.exit(1);
}

const [filePath, userName, aiName] = args;
console.log(`Parsing ${filePath}...\nUser Name: ${userName}\nAI Name: ${aiName}`);

const messages = processWhatsAppExport(filePath, userName, aiName);
console.log(`Found ${messages.length} valid messages.`);

if (messages.length === 0) {
  console.log("No messages parsed. Please check your regex or sender names.");
  process.exit(0);
}

const sessions = groupIntoSessions(messages);
console.log(`Grouped into ${sessions.length} sessions.`);

saveSessions(sessions);
