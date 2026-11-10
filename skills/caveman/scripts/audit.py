#!/usr/bin/env python3
import sys
import os
import re
import ast
from pathlib import Path
from typing import List, Tuple

# Regex patterns for native JS/TS replacements and standard library alternatives
JS_TS_PATTERNS = [
    (r"(?:function|const)\s+\w+\s*=\s*\(.*\)\s*=>\s*\{\s*return\s+JSON\.parse\(JSON\.stringify\(\w+\)\);\s*\}", "Use native 'structuredClone(obj)' instead of custom JSON.parse/stringify clone"),
    (r"new\s+Promise\(\s*resolve\s*=>\s*setTimeout\(\s*resolve\s*,\s*\w+\s*\)\)", "Use native 'scheduler.postTask' or std Promise.delay if available, or keep inline"),
    (r"function\s+pad\w*\(", "Use native String.prototype.padStart/padEnd instead of custom padding"),
    (r"function\s+parseQuery\w*\(", "Use native URLSearchParams for query string parsing"),
    (r"function\s+base64\w*\(", "Use native btoa/atob or Buffer for base64 encoding/decoding"),
]

PYTHON_PATTERNS = [
    (r"def\s+uuid\w*\(", "Use standard 'uuid' module instead of custom UUID generators"),
    (r"def\s+deep_copy\w*\(", "Use standard 'copy.deepcopy' instead of custom deep copy implementations"),
]

MD_PATTERNS = [
    (r"(?i)\b(uh oh|oh no|there seems to be|let me|i'll|sure|looking at your|to answer your question)\b", "Remove preamble, pleasantries, or apologies (ADHD rule)"),
    (r"(?i)\b(let me know|hope this helps|happy to clarify|feel free to ask)\b", "Remove closing pleasantries (ADHD rule)"),
    (r"(?i)\b(perhaps|might|could possibly)\b", "Remove hedging adverbs (ADHD rule)")
]

def check_python_ast(filepath: Path) -> List[Tuple[int, str]]:
    violations = []
    try:
        content = filepath.read_text(encoding="utf-8", errors="ignore")
        tree = ast.parse(content, filename=str(filepath))
    except Exception as e:
        return [(0, f"Failed to parse AST: {e}")]

    for node in ast.walk(tree):
        # Check: Assigning value to temp variable then immediately returning it (One-liner violation)
        if isinstance(node, ast.FunctionDef):
            if len(node.body) >= 2:
                last_two = node.body[-2:]
                if isinstance(last_two[0], ast.Assign) and isinstance(last_two[1], ast.Return):
                    target = last_two[0].targets[0]
                    retval = last_two[1].value
                    if isinstance(target, ast.Name) and isinstance(retval, ast.Name):
                        if target.id == retval.id:
                            violations.append((last_two[0].lineno, f"Redundant temp variable '{target.id}' assigned right before return. Return expression directly."))

    return violations

def check_file(filepath: Path) -> List[Tuple[int, str]]:
    violations = []
    suffix = filepath.suffix.lower()

    try:
        content = filepath.read_text(encoding="utf-8", errors="ignore")
    except OSError as e:
        return [(0, f"Could not read file: {e}")]

    lines = content.splitlines()

    # Check for placeholder/TODO comments (YAGNI/incomplete code check)
    for idx, line in enumerate(lines, 1):
        if re.search(r"//\s*(?:TODO|FIXME|placeholder)", line, re.IGNORECASE) or re.search(r"#\s*(?:TODO|FIXME|placeholder)", line, re.IGNORECASE):
            violations.append((idx, "Contains TODO/FIXME/placeholder comment (YAGNI/complete code rule)"))

    # Check Regex Patterns
    patterns = JS_TS_PATTERNS if suffix in (".js", ".ts", ".jsx", ".tsx") else PYTHON_PATTERNS if suffix == ".py" else MD_PATTERNS if suffix == ".md" else []
    for pattern, msg in patterns:
        for idx, line in enumerate(lines, 1):
            if re.search(pattern, line):
                violations.append((idx, msg))

    # Run AST check for Python
    if suffix == ".py":
        violations.extend(check_python_ast(filepath))

    return violations

def main():
    if len(sys.argv) < 2:
        print("Usage: audit.py <file_or_dir>")
        sys.exit(1)

    target_path = Path(sys.argv[1]).resolve()
    if not target_path.exists():
        print(f"Path not found: {target_path}")
        sys.exit(1)

    files_to_check = [target_path] if target_path.is_file() else [p for p in target_path.rglob("*") if p.is_file() and not any(part in (".git", "node_modules", "venv", "__pycache__") for part in p.parts)]

    total_violations = 0
    for filepath in files_to_check:
        if filepath.suffix.lower() not in (".py", ".js", ".ts", ".jsx", ".tsx", ".md"):
            continue

        violations = check_file(filepath)
        if violations:
            total_violations += len(violations)
            print(f"\n⚠️  {filepath.relative_to(target_path.parent if target_path.is_file() else target_path)}")
            for line_no, msg in violations:
                print(f"  Line {line_no}: {msg}")

    if total_violations > 0:
        print(f"\nAudit failed: {total_violations} violations found.")
        sys.exit(1)
    else:
        print("Audit passed: all clean.")
        sys.exit(0)

if __name__ == "__main__":
    main()
