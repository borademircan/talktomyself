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

# Use the current working directory as the installation directory
INSTALL_DIR="$PWD"
echo "Deploying TalkToMyself into current directory: $INSTALL_DIR"

# Create installation directory and enter it
mkdir -p "$INSTALL_DIR" || { echo "Failed to create directory. Do you need to run with sudo?"; exit 1; }
cd "$INSTALL_DIR"

if [ -d ".git" ]; then
    echo "Directory is already a git repository. Pulling latest changes..."
    git pull
    # If working directory is somehow empty/broken from a previous failed install, force restore it
    if [ ! -f "package.json" ]; then
        echo "Missing package.json detected. Force restoring files..."
        git reset --hard HEAD
    fi
else
    echo "Deploying into $INSTALL_DIR..."
    git init
    git remote add origin "$REPO_URL"
    git fetch
    
    # Try checking out main, fallback to master
    if git rev-parse --verify origin/main >/dev/null 2>&1; then
        git reset --hard origin/main
        git branch -M main
        git branch -u origin/main
    else
        git reset --hard origin/master
        git branch -M master
        git branch -u origin/master
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


# Setup .env file
echo "=========================================="
echo "Environment Setup (.env)"
echo "=========================================="
if [ ! -f .env ]; then
    echo "This application requires several API keys to function properly."
    echo "You can enter them now, or press Enter to skip and add them later."
    echo "An empty .env file will be created with placeholders for any skipped keys."
    echo ""

    read -p "Enter OpenAI API Key (or press Enter to skip): " VAL_OPENAI </dev/tty
    read -p "Enter ElevenLabs API Key (or press Enter to skip): " VAL_ELEVENLABS </dev/tty
    read -p "Enter ElevenLabs Voice ID (or press Enter to skip): " VAL_VOICE_ID </dev/tty
    read -p "Enter ElevenLabs Agent ID (or press Enter to skip): " VAL_AGENT_ID </dev/tty
    read -p "Enter Moonshot API Key (or press Enter to skip): " VAL_MOONSHOT </dev/tty
    read -p "Enter Claude API Key (or press Enter to skip): " VAL_CLAUDE </dev/tty
    read -p "Enter Gemini API Key (or press Enter to skip): " VAL_GEMINI </dev/tty
    read -p "Enter App Password for Web UI (or press Enter to skip): " VAL_PASSWORD </dev/tty
    
    if [ -n "$VAL_PASSWORD" ]; then
        VAL_AUTH="Basic $(echo -n "selin:${VAL_PASSWORD}" | base64)"
    else
        VAL_AUTH=""
    fi

    echo "Writing to .env file..."
    cat <<EOF > .env
VITE_OPENAI_API_KEY=${VAL_OPENAI}

VITE_ELEVENLABS_VOICE_ID=${VAL_VOICE_ID}
VITE_ELEVENLABS_API_KEY=${VAL_ELEVENLABS}
VITE_ELEVENLABS_AGENT_ID=${VAL_AGENT_ID}
VITE_MOONSHOT_API_KEY=${VAL_MOONSHOT}
VITE_CLAUDE_API_KEY=${VAL_CLAUDE}
VITE_GEMINI_API_KEY=${VAL_GEMINI}

# Authentication
VITE_APP_PASSWORD=${VAL_PASSWORD}
VITE_APP_AUTH=${VAL_AUTH}
EOF
    echo "Your .env file has been configured! You can manually edit it at any time at $INSTALL_DIR/.env"
else
    echo "A .env file already exists. Skipping environment setup."
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
