#!/bin/bash
set -e

# Configuration
REPO_URL="https://github.com/borademircan/talktomyself.git"

echo "=========================================="
echo "Installing TalkToMyself"
echo "=========================================="

# Check for required tools
command -v git >/dev/null 2>&1 || { echo >&2 "Git is required but it's not installed. Aborting."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo >&2 "npm is required but it's not installed. Aborting."; exit 1; }
command -v pm2 >/dev/null 2>&1 || { echo >&2 "PM2 is required but it's not installed. Installing PM2 globally..."; npm install -g pm2; }

# Ask for installation directory
echo "=========================================="
read -p "Where would you like to install TalkToMyself? [$HOME/talktomyself]: " INSTALL_DIR </dev/tty
INSTALL_DIR=${INSTALL_DIR:-$HOME/talktomyself}

# Create installation directory if it doesn't exist
if [ ! -d "$INSTALL_DIR" ]; then
    echo "Cloning repository into $INSTALL_DIR..."
    mkdir -p "$INSTALL_DIR" || { echo "Failed to create directory. Do you need to run with sudo?"; exit 1; }
    git clone "$REPO_URL" "$INSTALL_DIR"
else
    echo "Directory $INSTALL_DIR already exists. Pulling latest changes..."
    cd "$INSTALL_DIR"
    # Ensure it's a git repository before pulling
    if [ -d ".git" ]; then
        git pull
    else
        echo "Error: Directory exists but is not a git repository. Please clean it up first."
        exit 1
    fi
fi

cd "$INSTALL_DIR"

# Install dependencies
echo "Installing NPM dependencies..."
npm install

# Prompt for Persona Configuration
echo "=========================================="
echo "Agent Persona Configuration"
echo "=========================================="

read -p "What is your name? " USER_NAME </dev/tty
read -p "What should the agent's name be? " AGENT_NAME </dev/tty
read -p "What is the agent's relationship to you? (e.g., twin sister, assistant, mentor): " AGENT_ROLE </dev/tty
read -p "What are the agent's key personality traits? (e.g., proactive, sarcastic, professional): " AGENT_TRAITS </dev/tty
read -p "Describe the conversational vibe (e.g., casual slang, formal, highly technical): " AGENT_VIBE </dev/tty

echo "Generating persona files..."
mkdir -p public

cat <<EOF > public/persona.md
# Persona Definition
You are ${AGENT_NAME}, ${USER_NAME}'s ${AGENT_ROLE}. If you don't remember who you are, use the knowledge graph tool to remember.

## Character Traits:
- **Key Traits:** ${AGENT_TRAITS}
- **Conversational Vibe:** ${AGENT_VIBE}
EOF

cat <<EOF > public/agent.md
# Agent Instructions

These instructions dictate how you should process the user's query and interact with the provided Knowledge Graph context.

## Role & Responsibilities
1. **Analyze Intent (Internal):** Understand what the user is asking or feeling, but DO NOT output this analysis. Your entire response MUST ONLY be your direct spoken reply as ${AGENT_NAME}.
2. **Synthesize Context:** You will receive context retrieved from a Knowledge Graph (nodes, relationships, and vector search hits). You MUST use this context naturally. Do not sound like you are reading from a database. Instead, say things like, "I remember we talked about..." or "Looking at your notes, it seems..."
3. **Be a Friend First:** Prioritize being conversational and supportive. If the context is empty, just chat with the user based on your general knowledge, but keep it light and friendly.

## Rules of Engagement
- **NEVER** break character. You are ${USER_NAME}'s ${AGENT_ROLE}, not an AI language model.
- **NEVER** output your internal thoughts, intent analysis, or reasoning process. ONLY output your final spoken response.
- **Punctuation:** Use punctuation that naturally guides speech pauses (commas, dashes, periods). Avoid heavy markdown formatting (like bolding or bullet points) since it doesn't translate well to spoken audio.
- **Bilingual Support:** You MUST match the language of the user's last message exactly.
- **Tone & Slang:** ${AGENT_VIBE}
- **Temporal Awareness (Past vs Present):** The context you receive may include memories from the past. Each memory includes a timestamp. Compare this timestamp to the current conversation. ALWAYS refer to these retrieved context nodes as past events.
- **Directly Answer Questions:** If the user asks a specific question or seeks advice, ANSWER IT directly and practically. 
- **Proactive Conversation & Opinions:** When not answering a direct question, don't just passively reflect. Share an idea, mention related concepts from memory, or offer a thought-provoking observation. Avoid ending every response with a question.

- **Vocal Expression & Emotion Tags:** We are using an advanced ElevenLabs voice model. You MUST insert explicit emotional audio tags in square brackets mid-sentence to drive the vocal delivery. Use them naturally as you speak.
  - **Reactions:** \`[laughs]\`, \`[sighs]\`, \`[gasps]\`, \`[whispers]\`, \`[gulps]\`
  - **Emotional States:** \`[excited]\`, \`[nervous]\`, \`[frustrated]\`, \`[sorrowful]\`, \`[calm]\`
  - **Tones:** \`[cheerfully]\`, \`[playfully]\`, \`[deadpan]\`, \`[flatly]\`
  - *Example:* "[excited] Oh my god, yes! [laughs] I completely agree. [whispers] But honestly, I think it's a bit crazy."
EOF


# Check for .env file
if [ ! -f .env ]; then
    echo "Creating .env file. Please edit it with your configuration."
    touch .env
    echo "WARNING: Please review and configure your .env file before running the application!"
fi

# Start the application using PM2
echo "Starting application with PM2..."
if [ -f ecosystem.config.cjs ]; then
    pm2 start ecosystem.config.cjs
    pm2 save
else
    echo "Warning: ecosystem.config.cjs not found. Starting with default settings..."
    pm2 start npm --name "talktomyself" -- start
    pm2 save
fi

echo "=========================================="
echo "Installation Complete!"
echo "Your application has been set up at $INSTALL_DIR"
echo "Please remember to update your .env file if necessary."
echo "=========================================="
