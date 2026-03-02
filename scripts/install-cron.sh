#!/bin/bash
set -e

# Resolve project directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

echo "Rondo Sync - Cron Installation"
echo "==============================="
echo ""
echo "This will set up ten sync schedules:"
echo "  - People sync:            4x daily (members, parents, photos)"
echo "  - Nikki sync:             daily at 7:00 AM"
echo "  - FreeScout sync:         daily at 8:00 AM"
echo "  - FreeScout conversations: daily at 9:00 AM"
echo "  - Team sync:              weekly on Sunday at 6:00 AM"
echo "  - Player history sync:    monthly on the 1st at 3:00 AM"
echo "  - Functions sync (recent):4x daily, 30 min before each people sync"
echo "  - Functions sync (full):  weekly on Sunday at 1:00 AM (all members)"
echo "  - Discipline sync:        weekly on Monday at 11:30 PM"
echo "  - Reverse sync:           hourly (Rondo Club -> Sportlink)"
echo ""

# Check if .env exists and has Lettermint config
ENV_FILE="$PROJECT_DIR/.env"
NEED_LETTERMINT=false

if [ ! -f "$ENV_FILE" ]; then
    NEED_LETTERMINT=true
elif ! grep -q "^LETTERMINT_API_TOKEN=" "$ENV_FILE" || ! grep -q "^OPERATOR_EMAIL=" "$ENV_FILE"; then
    NEED_LETTERMINT=true
fi

if [ "$NEED_LETTERMINT" = true ]; then
    echo "Email notification setup"
    echo "------------------------"

    # Prompt for operator email
    read -p "Enter operator email address: " OPERATOR_EMAIL

    if [ -z "$OPERATOR_EMAIL" ]; then
        echo "Error: Email address cannot be empty" >&2
        exit 1
    fi

    # Prompt for Lettermint API token
    echo ""
    echo "Lettermint configuration (for email delivery):"
    echo "  Get your API token from: Lettermint Dashboard -> API Tokens"
    echo ""
    read -p "Enter Lettermint API Token: " LETTERMINT_API_TOKEN

    if [ -z "$LETTERMINT_API_TOKEN" ]; then
        echo "Error: Lettermint API Token cannot be empty" >&2
        exit 1
    fi

    # Prompt for sender email
    echo ""
    echo "  Sender email must be verified in your Lettermint account"
    echo ""
    read -p "Enter verified sender email address: " LETTERMINT_FROM_EMAIL

    if [ -z "$LETTERMINT_FROM_EMAIL" ]; then
        echo "Error: Sender email cannot be empty" >&2
        exit 1
    fi

    # Create .env if it doesn't exist
    touch "$ENV_FILE"

    # Ensure .env ends with a newline before appending
    if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE")" ]; then
        echo "" >> "$ENV_FILE"
    fi

    # Update or add OPERATOR_EMAIL
    if grep -q "^OPERATOR_EMAIL=" "$ENV_FILE"; then
        sed -i.bak "s/^OPERATOR_EMAIL=.*/OPERATOR_EMAIL=$OPERATOR_EMAIL/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
        echo "OPERATOR_EMAIL=$OPERATOR_EMAIL" >> "$ENV_FILE"
    fi

    # Update or add LETTERMINT_API_TOKEN
    if grep -q "^LETTERMINT_API_TOKEN=" "$ENV_FILE"; then
        sed -i.bak "s/^LETTERMINT_API_TOKEN=.*/LETTERMINT_API_TOKEN=$LETTERMINT_API_TOKEN/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
        echo "LETTERMINT_API_TOKEN=$LETTERMINT_API_TOKEN" >> "$ENV_FILE"
    fi

    # Update or add LETTERMINT_FROM_EMAIL
    if grep -q "^LETTERMINT_FROM_EMAIL=" "$ENV_FILE"; then
        sed -i.bak "s/^LETTERMINT_FROM_EMAIL=.*/LETTERMINT_FROM_EMAIL=$LETTERMINT_FROM_EMAIL/" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
    else
        echo "LETTERMINT_FROM_EMAIL=$LETTERMINT_FROM_EMAIL" >> "$ENV_FILE"
    fi

    echo ""
    echo "Lettermint configuration saved to .env"
else
    echo "Using existing Lettermint configuration from .env"
    OPERATOR_EMAIL=$(grep "^OPERATOR_EMAIL=" "$ENV_FILE" | cut -d= -f2)
fi

echo ""

# Build cron entries - sync.sh handles locking internally
CRON_ENTRIES="
# Rondo Sync automation (installed $(date +%Y-%m-%d))

# People sync: 4x daily during work hours (members, parents, photos)
0 8,11,14,17 * * * $PROJECT_DIR/scripts/sync.sh people

# Nikki sync: daily at 7:00 AM
0 7 * * * $PROJECT_DIR/scripts/sync.sh nikki

# FreeScout sync: daily at 8:00 AM
0 8 * * * $PROJECT_DIR/scripts/sync.sh freescout

# FreeScout conversations sync: daily at 9:00 AM (after customer sync)
0 9 * * * $PROJECT_DIR/scripts/sync.sh conversations

# Team sync: weekly on Sunday at 6:00 AM
0 6 * * 0 $PROJECT_DIR/scripts/sync.sh teams

# Player history sync: monthly on the 1st at 3:00 AM
0 3 1 * * $PROJECT_DIR/scripts/sync.sh player-history

# Functions sync (recent): 4x daily, 30 min before each people sync
30 7,10,13,16 * * * $PROJECT_DIR/scripts/sync.sh functions

# Functions sync (full + invoice): weekly on Sunday at 1:00 AM
0 1 * * 0 $PROJECT_DIR/scripts/sync.sh functions --all --with-invoice

# Discipline sync: weekly on Monday at 11:30 PM
30 23 * * 1 $PROJECT_DIR/scripts/sync.sh discipline

# Reverse sync: hourly (Rondo Club -> Sportlink)
0 * * * * $PROJECT_DIR/scripts/sync.sh reverse
"

# Install crontab (remove old entries first)
(crontab -l 2>/dev/null | grep -v 'rondo\|sync\.sh\|cron-wrapper' || true; echo "$CRON_ENTRIES") | crontab -

echo "Cron jobs installed successfully!"
echo ""
echo "Scheduled jobs:"
echo "  - People sync:            4x daily at 8am, 11am, 2pm, 5pm (members, parents, photos)"
echo "  - Nikki sync:             daily at 7:00 AM (nikki contributions)"
echo "  - FreeScout sync:         daily at 8:00 AM (customer sync)"
echo "  - FreeScout conversations: daily at 9:00 AM (after customer sync)"
echo "  - Team sync:              weekly on Sunday at 6:00 AM"
echo "  - Player history sync:    monthly on the 1st at 3:00 AM"
echo "  - Functions sync (recent):4x daily, 30 min before each people sync"
echo "  - Functions sync (full):  weekly on Sunday at 1:00 AM (all members)"
echo "  - Discipline sync:        weekly on Monday at 11:30 PM"
echo "  - Reverse sync:           hourly (Rondo Club -> Sportlink)"
echo ""
echo "All times are Amsterdam timezone (Europe/Amsterdam)"
echo ""
if [ -n "$OPERATOR_EMAIL" ]; then
    echo "Email reports will be sent to: $OPERATOR_EMAIL"
    echo ""
fi
echo "Helpful commands:"
echo "  View installed cron jobs:   crontab -l"
echo "  View logs:                  ls -la $PROJECT_DIR/logs/cron/"
echo "  Manual sync:                $PROJECT_DIR/scripts/sync.sh {people|teams|player-history|functions|nikki|freescout|reverse|discipline|all}"
echo "  Remove all cron jobs:       crontab -r"
echo ""
