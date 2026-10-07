#!/bin/bash
set -e
umask 077

# Resolve project directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

echo "Rondo Sync - Cron Installation"
echo "==============================="
echo ""
echo "This installs a minute-by-minute schedule check and preserves existing sync timings."
echo "Edit schedules in the web interface under Beheer -> Sync schedules."
echo "Twelve keeps its club opening windows in Rondo Club."
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
    read -s -p "Enter Lettermint API Token: " LETTERMINT_API_TOKEN
    echo ""

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
    chmod 600 "$ENV_FILE"

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
    chmod 600 "$ENV_FILE"
    OPERATOR_EMAIL=$(grep "^OPERATOR_EMAIL=" "$ENV_FILE" | cut -d= -f2)
fi

echo ""

# Run the installer as the sync user so configuration, backups, and jobs remain
# owned by rondo. The Node installer preserves unrelated crontab entries.
if [ "$(id -u)" -eq 0 ]; then
    if ! id -u rondo >/dev/null 2>&1; then
        echo "ERROR: target user 'rondo' does not exist." >&2
        exit 1
    fi
    runuser -u rondo -- node "$PROJECT_DIR/scripts/install-schedule-cron.js"
else
    node "$PROJECT_DIR/scripts/install-schedule-cron.js"
fi
