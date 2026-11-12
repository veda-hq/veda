#!/usr/bin/env bash
# The shell check absolute-paths.ts was ported from, kept as the oracle its
# differential test runs against. Verbatim but for file selection, which
# came from a shared library (see get_files below). Not shipped; never edit
# it to match the port.
# Prevent absolute paths in documentation files
# AI agents should not reference local file paths or non-synced resources

set -euo pipefail

# The `--files` branch of the shared get_files, the one mode the port keeps
# (`--files-from`): operands that are regular files, then the pattern.
get_files() {
  local pattern="${2:-.*}"
  local files="" file
  shift 2
  for file in "$@"; do
    if [ -f "$file" ]; then
      files+="$file"$'\n'
    fi
  done
  printf '%s\n' "$files" | grep -E "$pattern" | grep -v '^$' || true
}

# Parse arguments
MODE="${1:---staged-and-modified}"
DOC_PATTERN="\\.(md|mdx)$"

# Show help
if [ "$MODE" = "--help" ] || [ "$MODE" = "-h" ]; then
  echo "Usage: $0 [MODE]"
  echo ""
  echo "Modes:"
  echo "  --all                  Check all documentation files"
  echo "  --staged               Check staged documentation files (default for pre-commit)"
  echo "  --staged-and-modified  Check both staged and modified (default)"
  echo "  --unpushed             Check documentation files in unpushed commits (pre-push)"
  echo "  --push-diff            Check documentation files in last commit (CI push events)"
  echo "  --pr-diff              Check documentation files changed in PR (CI PR events)"
  echo "  --files FILE1 FILE2    Check specific files"
  echo "  --help, -h             Show this help message"
  exit 0
fi

# Function to check if absolute path is within backticks
# Returns 0 if path is in backticks, 1 otherwise
check_path_in_backticks() {
  local line_content="$1"
  echo "$line_content" | awk '{
    line = $0;
    # Find position of absolute path pattern
    match(line, /(file:\/\/|\/Users\/|\/home\/[^\/]+\/|C:\\[^\/]|\/tmp\/[^\/]+|\/var\/[^\/]+|\/private\/var|~\/|[A-Z]:\\[^\/])/);
    if (RSTART == 0) exit 1; # Pattern not found
    path_start = RSTART;
    path_end = RSTART + RLENGTH - 1;
    
    # Count backticks before the path (using hex code to avoid bash interpretation)
    before = substr(line, 1, path_start - 1);
    backticks_before = gsub(/\x60/, "\x60", before);
    
    # Count backticks after the path
    after = substr(line, path_end + 1);
    backticks_after = gsub(/\x60/, "\x60", after);
    
    # Path is in backticks if:
    # 1. There is at least one backtick before
    # 2. There is at least one backtick after
    # 3. The backticks before are odd (meaning we are inside a backtick pair)
    
    if (backticks_before > 0 && backticks_after > 0 && backticks_before % 2 == 1) {
      exit 0; # Path is in backticks
    }
    exit 1; # Path is NOT in backticks
  }'
}

echo "→ Checking for absolute paths in documentation..."

# Get documentation files based on mode
# Only --files consumes CLI file operands; diff modes keep their existing scope.
if [ "$MODE" = "--files" ]; then
  FILES=$(get_files "$MODE" "$DOC_PATTERN" "${@:2}")
else
  FILES=$(get_files "$MODE" "$DOC_PATTERN")
fi

if [ -z "$FILES" ]; then
  echo "✅ No documentation files to check."
  exit 0
fi

# Count files
FILE_COUNT=$(echo "$FILES" | wc -l | tr -d ' ')
echo "   Checking $FILE_COUNT documentation file(s)..."

# Check for absolute paths (file://, /Users/, /home/, C:\, ~/, etc.)
# Also check for common patterns that indicate local-only references
# Ignore patterns in backticks (code examples) or code blocks
FOUND=""
while IFS= read -r file; do
  if [ -z "$file" ]; then continue; fi
  
  # Track code block state (inside triple backticks)
  in_code_block=0
  line_num=0
  
  # Read file line by line to track code block state
  while IFS= read -r line_content || [ -n "$line_content" ]; do
    line_num=$((line_num + 1))
    
    # Check if this line starts or ends a code block (triple backticks)
    if grep -qE '^```' <<<"$line_content"; then
      # Toggle code block state
      in_code_block=$((1 - in_code_block))
      continue
    fi
    
    # Skip checking if we're inside a code block
    if [ "$in_code_block" -eq 1 ]; then
      continue
    fi
    
    # Check for absolute path patterns
    if grep -qE "(file://|/Users/|/home/[^/]+/|C:\\\\[^/]|/tmp/[^/]+|/var/[^/]+|/private/var|~/|[A-Z]:\\\\[^/])" <<<"$line_content"; then
      # Check if the pattern is within inline backticks (single backticks)
      if check_path_in_backticks "$line_content" >/dev/null 2>&1; then
        continue
      fi
      
      # Skip if it's clearly a documentation example (contains "FORBIDDEN" or similar)
      if grep -qiE '(forbidden|example|not allowed|should not|must not)' <<<"$line_content"; then
        continue
      fi
      
      # This is a real violation
      if [ -z "$FOUND" ]; then
        FOUND="$file:$line_num:$line_content"
      else
        FOUND="$FOUND"$'\n'"$file:$line_num:$line_content"
      fi
    fi
  done < "$file"
done <<< "$FILES"

if [ -n "$FOUND" ]; then
  echo ""
  echo "❌ Error: Absolute paths or local file references found:"
  echo ""
  echo "$FOUND"
  echo ""
  echo "Please use relative paths only:"
  echo "  - Code files: ../../src/screens/ScreenName.tsx"
  echo "  - Images: ./image.png"
  echo "  - Other docs: ../ARCHITECTURE.md"
  echo ""
  echo "See docs/AGENT_GUIDELINES.md for documentation guidelines"
  exit 1
fi

echo "✅ No absolute paths found in documentation"

