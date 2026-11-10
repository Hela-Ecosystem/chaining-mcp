#!/usr/bin/env bash
# Install git hooks to enforce Decision Hierarchy and RTK rules

HOOKS_DIR=$(git rev-parse --git-path hooks 2>/dev/null)

if [ -z "$HOOKS_DIR" ]; then
    echo "❌ Error: Not a git repository or git hooks directory not found."
    exit 1
fi

PRE_COMMIT_FILE="$HOOKS_DIR/pre-commit"
AUDIT_SCRIPT="/home/azzar/.agents/skills/caveman/scripts/audit.py"

cat << 'EOF' > "$PRE_COMMIT_FILE"
#!/usr/bin/env bash
# Pre-commit hook to verify caveman rules (YAGNI, stdlib, native features)

STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(py|js|ts|jsx|tsx|md)$')

if [ -z "$STAGED_FILES" ]; then
    exit 0
fi

VIOLATIONS=0
for FILE in $STAGED_FILES; do
    if [ -f "$FILE" ]; then
        python3 /home/azzar/.agents/skills/caveman/scripts/audit.py "$FILE"
        if [ $? -ne 0 ]; then
            VIOLATIONS=$((VIOLATIONS + 1))
        fi
    fi
done

if [ $VIOLATIONS -gt 0 ]; then
    echo "❌ Commit aborted: Caveman audit failed with $VIOLATIONS file violations."
    exit 1
fi
EOF

chmod +x "$PRE_COMMIT_FILE"
echo "✔️ pre-commit hook installed successfully in $PRE_COMMIT_FILE."
