# Predictive Fake Typing (VSCode Extension)

## Features
- Load code snippets from a file (default: `predict-snippets.txt`)
- Support multiple template snippets in one file, separated by `===` on its own line
- Start predictive fake typing for the current snippet, or jump directly to the previous/next snippet
- Automatically turn fake typing off when the current snippet is fully typed (configurable)
- Pick the snippets file and progress output file from hotkeys
- Write progress as `currentLine,totalLines` using absolute line numbers from the whole template file
- If no progress file is configured, write by default to `.predictive-fake-typing-progress.txt` in the workspace root

## Hotkeys
- `PgUp`: Start the previous snippet
- `PgDn`: Start the next snippet
- `Esc`: Exit fake typing mode
- `Ctrl+Shift+Alt+T`: Toggle fake typing mode for the current snippet
- `F6`: Reload snippets file
- `F7`: Pick snippets file
- `F8`: Pick progress file

## Settings
Configure in VSCode `settings.json`:

```json
{
  "predictiveFakeTyping.snippetsFile": "predict-snippets.txt",
  "predictiveFakeTyping.blockSeparator": "\n===\n",
  "predictiveFakeTyping.syncExternalChanges": true,
  "predictiveFakeTyping.triggerSuggest": true,
  "predictiveFakeTyping.autoDisableOnSnippetEnd": true,
  "predictiveFakeTyping.progressFile": "typing-progress.txt"
}
```

`predictiveFakeTyping.progressFile` is optional. If you do not set it, the extension writes progress to `.predictive-fake-typing-progress.txt` in the workspace root.

## Snippet File Format
Use `===` on its own line to separate snippets, for example:

```txt
function hello() {
  console.log("hello");
}
===
const sum = (a, b) => a + b;
===
def greet(name):
    print(name)
```

`PgDn` starts the next snippet, `PgUp` starts the previous snippet, and `Esc` exits the mode.

## Progress File Format
The extension overwrites the progress file while typing.

Example:

```txt
45,127
```

This means the current output position is on line 45 of a 127-line template file.
Line numbers are counted against the whole template file, not just the current snippet block.

## Run in Dev
1. `npm install`
2. `npm run compile`
3. Press `F5` in VSCode to start Extension Development Host
