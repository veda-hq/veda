#!/usr/bin/env bash
# The shell check non-synced-resources.ts was ported from, kept as the oracle its
# differential test runs against. Verbatim but for file selection, which
# came from a shared library (see get_files below). Not shipped; never edit
# it to match the port.
# Prevent references to files/resources not committed to GitHub
# AI agents should not reference external resources that aren't in the repository

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

echo "→ Checking for non-synced resource references..."

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

# Get repository root
REPO_ROOT=$(git rev-parse --show-toplevel)

# Check for references to files that don't exist in the repository
# This checks markdown links that reference relative paths
HAS_ERRORS=false

# 0 when directory $1 holds an entry named exactly $2, in exactly that case.
# A glob, not `ls | grep`: ls output is for people and mangles unusual names
# (SHELL-01 / SC2010).
name_on_disk() {
  local entry
  # `.` and `..` (a link to ./ or ../) always exist and are never listed.
  case "$2" in
    . | ..) return 0 ;;
  esac
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ "${entry##*/}" = "$2" ]; then return 0; fi
  done
  return 1
}

while IFS= read -r file; do
  if [ -z "$file" ]; then continue; fi
  
  FILE_DIR=$(dirname "$file")
  
  # Extract markdown links: [text](path) or ![alt](path)
  # We'll check relative paths only (not http/https links or anchors)
  # `]` goes first inside a bracket to be literal: the previous `[^\]]` is not
  # valid ERE, matched no ordinary link, and so this check never compared a
  # single link (found when the delegate first ran on real files, work folder
  # 0063 R-05). A link title ("[t](path "title")") is dropped below.
  LINKS=$(grep -oE '!?\[[^]]*\]\([^)]+\)' "$file" | sed -E 's/^!?\[[^]]*\]\(([^)]+)\)$/\1/' | grep -vE '^(https?://|mailto:|#)' || true)
  
  if [ -n "$LINKS" ]; then
    while IFS= read -r link; do
      # Skip empty links
      [ -z "$link" ] && continue
      
      # Strip URL fragments (anchors) and query strings from the link path
      link="${link%%#*}"  # Remove everything from # onwards
      link="${link%%\?*}"  # Remove everything from ? onwards
      if [[ "$link" == \<*\>* ]]; then
        # <path with spaces> "optional title": the destination is inside < >
        link="${link#<}"
        link="${link%%>*}"
      else
        link="${link%% *}"   # Remove an optional link title
      fi
      [ -z "$link" ] && continue
      
      # Resolve relative path from the file's directory
      if [[ "$link" == /* ]]; then
        # Absolute path (shouldn't happen, but check anyway)
        TARGET_PATH="$REPO_ROOT$link"
      elif [[ "$FILE_DIR" == /* ]]; then
        # Relative link in a file named by absolute path (package wrappers
        # hand delegates absolute paths)
        TARGET_PATH="$FILE_DIR/$link"
      else
        # Relative link in a file named relative to the repo root
        TARGET_PATH="$REPO_ROOT/$FILE_DIR/$link"
      fi
      
      # Normalize path (resolve .. and .)
      if [ -n "$TARGET_PATH" ]; then
        PARENT_DIR=$(dirname "$TARGET_PATH")
        if [ ! -d "$PARENT_DIR" ]; then
          # Parent directory doesn't exist - this is a broken link
          RELATIVE_PATH="${TARGET_PATH#$REPO_ROOT/}"
          if [[ "$TARGET_PATH" == "$REPO_ROOT"/* ]]; then
            echo "❌ Error: Reference to file in non-existent directory in $file:"
            echo "   Link: $link"
            echo "   Expected path: $RELATIVE_PATH"
            echo "   Parent directory does not exist"
            echo ""
            HAS_ERRORS=true
            continue
          fi
        fi
        
        # Try to normalize the path (parent dir exists, so cd should work)
        NORMALIZED_DIR=$(cd "$PARENT_DIR" 2>/dev/null && pwd) || {
          NORMALIZED_DIR="$PARENT_DIR"
        }
        TARGET_PATH="$NORMALIZED_DIR/$(basename "$TARGET_PATH")"
      else
        continue
      fi
      
      # Check if the normalized path is outside the repository (security check)
      if [[ "$TARGET_PATH" != "$REPO_ROOT"/* ]]; then
        echo "❌ Error: Reference to file outside repository in $file:"
        echo "   Link: $link"
        echo "   Resolved path: $TARGET_PATH"
        echo "   All references must be within the repository"
        echo ""
        HAS_ERRORS=true
        continue
      fi
      
      # Check if the target exists in the repository
      RELATIVE_PATH="${TARGET_PATH#$REPO_ROOT/}"
      if [ ! -f "$TARGET_PATH" ] && [ ! -d "$TARGET_PATH" ]; then
        echo "❌ Error: Reference to non-existent file in $file:"
        echo "   Link: $link"
        echo "   Expected path: $RELATIVE_PATH"
        echo ""
        HAS_ERRORS=true
      elif ! name_on_disk "$(dirname "$TARGET_PATH")" "$(basename "$TARGET_PATH")"; then
        # macOS resolves a wrongly-cased name; Linux (and CI) does not.
        echo "❌ Error: Reference whose case differs from the file on disk in $file:"
        echo "   Link: $link"
        echo "   Expected path: $RELATIVE_PATH"
        echo ""
        HAS_ERRORS=true
      fi
      
      # Check image size (if it's an image)
      if [[ "$TARGET_PATH" =~ \.(png|jpg|jpeg|gif|webp)$ ]]; then
        if [ -f "$TARGET_PATH" ]; then
          # Get file size in bytes
          if [[ "$(uname)" == "Darwin" ]]; then
            SIZE=$(stat -f%z "$TARGET_PATH")
          else
            SIZE=$(stat -c%s "$TARGET_PATH")
          fi
          
          # Warn if larger than 1MB (1048576 bytes)
          if [ "$SIZE" -gt 1048576 ]; then
            # Calculate size in KB using shell arithmetic (no external tools required)
            SIZE_KB=$((SIZE / 1024))
            SIZE_MB_APPROX=$((SIZE / 1024 / 1024))
            echo "⚠️  Warning: Large image referenced in $file:"
            echo "   Image: $RELATIVE_PATH"
            echo "   Size: ~${SIZE_MB_APPROX} MB (${SIZE_KB} KB)"
            echo "   Consider compressing images to keep repository size small."
            echo ""
          fi
        fi
      fi
    done <<< "$LINKS"
  fi
done <<< "$FILES"

if [ "$HAS_ERRORS" = true ]; then
  echo ""
  echo "Please ensure all referenced files exist in the repository."
  echo "See docs/AGENT_GUIDELINES.md for documentation guidelines"
  exit 1
fi

echo "✅ All resource references are valid"

